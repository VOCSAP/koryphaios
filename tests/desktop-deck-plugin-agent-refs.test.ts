import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative } from "node:path";
import { test, expect } from "bun:test";

const PLUGIN_DIR = join(import.meta.dir, "..", "desktop", "deck-plugin");
const AGENTS_DIR = join(PLUGIN_DIR, "agents");

type PluginFile = {
  path: string;
  content: string;
};

type Frontmatter =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "parsed"; value: Record<string, unknown> };

function findFiles(dir: string, matches: (entry: string) => boolean): string[] {
  if (!existsSync(dir)) return [];

  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findFiles(full, matches));
    else if (matches(entry)) found.push(full);
  }
  return found;
}

function frontmatterObject(text: string): Frontmatter {
  const lines = text.split(/\r?\n/);
  const first = lines[0] ?? "";
  const opener = (first.charCodeAt(0) === 0xfeff ? first.slice(1) : first).trim();
  if (opener !== "---") return { state: "absent" };

  const closer = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closer === -1) return { state: "invalid" };

  try {
    const parsed = Bun.YAML.parse(lines.slice(1, closer).join("\n"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid" };
    }
    return { state: "parsed", value: parsed as Record<string, unknown> };
  } catch {
    return { state: "invalid" };
  }
}

function frontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
  return frontmatter[key];
}

function inspectAgentConfiguration(
  pluginName: string,
  skillFiles: PluginFile[],
  agentFiles: PluginFile[],
) {
  const agentOffenders: string[] = [];
  const referenceOffenders: string[] = [];
  const agentsByName = new Map<string, string>();
  const agentReferences: string[] = [];

  for (const file of agentFiles) {
    const agentFm = frontmatterObject(file.content);
    if (agentFm.state !== "parsed") {
      const problem =
        agentFm.state === "absent" ? "no frontmatter block" : "invalid frontmatter YAML";
      agentOffenders.push(`${file.path}: ${problem}, so its name: went unchecked`);
      continue;
    }

    const declaredName = frontmatterValue(agentFm.value, "name");
    const filename = basename(file.path, extname(file.path));
    if (typeof declaredName !== "string" || declaredName !== filename) {
      agentOffenders.push(`${file.path}: frontmatter name "${declaredName}" does not match filename "${filename}"`);
      continue;
    }
    if (agentsByName.has(declaredName)) {
      agentOffenders.push(`${file.path}: duplicates the delivered agent name "${declaredName}"`);
      continue;
    }
    agentsByName.set(declaredName, file.path);
  }

  for (const file of skillFiles) {
    const skillFm = frontmatterObject(file.content);
    if (skillFm.state !== "parsed") {
      const problem =
        skillFm.state === "absent" ? "no frontmatter block" : "invalid frontmatter YAML";
      referenceOffenders.push(`${file.path}: ${problem}, so its agent: went unchecked`);
      continue;
    }

    const agentRef = frontmatterValue(skillFm.value, "agent");
    if (agentRef === undefined) continue;
    if (typeof agentRef !== "string") {
      referenceOffenders.push(`${file.path}: agent must be a string`);
      continue;
    }
    agentReferences.push(agentRef);

    if (!agentRef.startsWith(`${pluginName}:`)) {
      referenceOffenders.push(
        `${file.path}: agent "${agentRef}" is not prefixed with "${pluginName}:"`,
      );
      continue;
    }

    const bare = agentRef.slice(pluginName.length + 1);
    if (!agentsByName.has(bare)) {
      referenceOffenders.push(`${file.path}: agent "${agentRef}" has no delivered agent file`);
    }
  }

  const referencedAgents = new Set(
    agentReferences
      .filter((agentRef) => agentRef.startsWith(`${pluginName}:`))
      .map((agentRef) => agentRef.slice(pluginName.length + 1)),
  );
  for (const [name, file] of agentsByName) {
    if (!referencedAgents.has(name)) {
      agentOffenders.push(`${file}: delivered agent "${name}" has no SKILL.md caller`);
    }
  }

  return { agentOffenders, referenceOffenders, agentReferences };
}

function pluginFile(path: string, frontmatter: string): PluginFile {
  return { path, content: `---\n${frontmatter}\n---\n` };
}

const pluginName = JSON.parse(
  readFileSync(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"),
).name as string;
const skillPaths = findFiles(join(PLUGIN_DIR, "skills"), (entry) => entry === "SKILL.md");
const agentPaths = findFiles(AGENTS_DIR, (entry) => entry.endsWith(".md"));
const agentConfiguration = inspectAgentConfiguration(
  pluginName,
  skillPaths.map((path) => ({ path, content: readFileSync(path, "utf8") })),
  agentPaths.map((path) => ({ path, content: readFileSync(path, "utf8") })),
);

test("the deck plugin declares a name, since it is the agent-resolution prefix", () => {
  expect(typeof pluginName).toBe("string");
  expect(pluginName.length).toBeGreaterThan(0);
});

test("the deck plugin delivers at least one skill", () => {
  expect(skillPaths.length).toBeGreaterThan(0);
});

test("findFiles discovers nested matching files without a product file list", () => {
  const root = mkdtempSync(join(tmpdir(), "deck-plugin-agent-refs-"));
  try {
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "root");
    writeFileSync(join(root, "nested", "deeper", "SKILL.md"), "nested");
    writeFileSync(join(root, "nested", "note.md"), "ignored");

    expect(
      findFiles(root, (entry) => entry === "SKILL.md")
        .map((path) => relative(root, path))
        .sort(),
    ).toEqual(["SKILL.md", join("nested", "deeper", "SKILL.md")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every plugin skill agent reference is qualified and resolves a delivered agent", () => {
  expect(agentConfiguration.referenceOffenders).toEqual([]);
});

test("every delivered plugin agent has a valid name and a SKILL.md caller", () => {
  expect(agentConfiguration.agentOffenders).toEqual([]);
});

test("YAML-valid agent spellings expose the same agent reference", () => {
  for (const line of ["agent : plugin:ready", '"agent": plugin:ready', "{agent: plugin:ready}"]) {
    const frontmatter = frontmatterObject(`---\n${line}\n---`);
    expect(frontmatter.state).toBe("parsed");
    if (frontmatter.state !== "parsed") throw new Error("expected parsed frontmatter");
    expect(frontmatterValue(frontmatter.value, "agent")).toBe("plugin:ready");
  }
});

test("the inspector resolves qualified agents from nested directories", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [pluginFile("skills/nested/SKILL.md", "agent: plugin:ready")],
    [pluginFile("agents/nested/ready.md", "name: ready")],
  );

  expect(result.referenceOffenders).toEqual([]);
  expect(result.agentOffenders).toEqual([]);
});

test("the inspector rejects an unqualified agent reference", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [pluginFile("skills/SKILL.md", "agent: ready")],
    [pluginFile("agents/ready.md", "name: ready")],
  );

  expect(result.referenceOffenders).toEqual([
    'skills/SKILL.md: agent "ready" is not prefixed with "plugin:"',
  ]);
});

test("the inspector rejects a reference without a delivered agent", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [pluginFile("skills/SKILL.md", "agent: plugin:missing")],
    [],
  );

  expect(result.referenceOffenders).toEqual([
    'skills/SKILL.md: agent "plugin:missing" has no delivered agent file',
  ]);
});

test("the inspector rejects a delivered agent without a caller", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [],
    [pluginFile("agents/nested/orphan.md", "name: orphan")],
  );

  expect(result.agentOffenders).toEqual([
    'agents/nested/orphan.md: delivered agent "orphan" has no SKILL.md caller',
  ]);
});

test("the inspector rejects missing skill and agent frontmatter", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [{ path: "skills/missing/SKILL.md", content: "agent: plugin:ready" }],
    [{ path: "agents/missing.md", content: "name: missing" }],
  );

  expect(result.referenceOffenders).toEqual([
    "skills/missing/SKILL.md: no frontmatter block, so its agent: went unchecked",
  ]);
  expect(result.agentOffenders).toEqual([
    "agents/missing.md: no frontmatter block, so its name: went unchecked",
  ]);
});

test("the inspector rejects malformed skill and agent frontmatter", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [{ path: "skills/invalid/SKILL.md", content: "---\nagent: [\n---\n" }],
    [{ path: "agents/invalid.md", content: "---\nname: [\n---\n" }],
  );

  expect(result.referenceOffenders).toEqual([
    "skills/invalid/SKILL.md: invalid frontmatter YAML, so its agent: went unchecked",
  ]);
  expect(result.agentOffenders).toEqual([
    "agents/invalid.md: invalid frontmatter YAML, so its name: went unchecked",
  ]);
});

test("the inspector rejects a non-string agent reference", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [pluginFile("skills/SKILL.md", "agent: [plugin:ready]")],
    [],
  );

  expect(result.referenceOffenders).toEqual(["skills/SKILL.md: agent must be a string"]);
});

test("the inspector rejects an agent name that differs from its filename", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [],
    [pluginFile("agents/nested/actual.md", "name: declared")],
  );

  expect(result.agentOffenders).toEqual([
    'agents/nested/actual.md: frontmatter name "declared" does not match filename "actual"',
  ]);
});

test("the inspector rejects duplicate delivered agent names", () => {
  const result = inspectAgentConfiguration(
    "plugin",
    [pluginFile("skills/SKILL.md", "agent: plugin:ready")],
    [
      pluginFile("agents/ready.md", "name: ready"),
      pluginFile("agents/nested/ready.md", "name: ready"),
    ],
  );

  expect(result.agentOffenders).toEqual([
    'agents/nested/ready.md: duplicates the delivered agent name "ready"',
  ]);
});

test("the deck plugin intentionally delivers no agents and declares no agent references", () => {
  expect(agentPaths).toEqual([]);
  expect(agentConfiguration.agentReferences).toEqual([]);
});
