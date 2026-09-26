// The repo-rules skill and hooks.json cite the plugin's TTSR build outputs by
// path. Those paths are written by hand in three independent places
// (package.json's build scripts, hooks.json, SKILL.md) and nothing keeps them
// in sync except this test -- on the model of
// tests/desktop-deck-plugin-agent-refs.test.ts for the agent/plugin-name pair.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_DIR = join(import.meta.dir, "..", "desktop");
const PACKAGE_JSON = join(DESKTOP_DIR, "package.json");
const HOOKS_JSON = join(DESKTOP_DIR, "deck-plugin", "hooks", "hooks.json");
const SKILL_MD = join(DESKTOP_DIR, "deck-plugin", "skills", "repo-rules", "SKILL.md");

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as { scripts: Record<string, string> };

/** The `--outfile=` value bun build writes for a given entry point, extracted
 * from a package.json script string that chains several `bun build` calls
 * with `&&`. Throws if the entry point is not built by that script at all. */
function outfileFor(script: string, entryPoint: string): string {
  const re = new RegExp(
    `bun build ${entryPoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^&]*--outfile=(\\S+)`
  );
  const m = re.exec(script);
  if (!m) throw new Error(`no "bun build ${entryPoint} ... --outfile=" found in: ${script}`);
  return m[1]!;
}

/** Strips the `deck-plugin/` prefix a build:* script's outfile always carries,
 * to compare against a path already rooted at the plugin dir (as hooks.json's
 * ${CLAUDE_PLUGIN_ROOT}/... and SKILL.md's ${CLAUDE_PLUGIN_ROOT}/... are). */
function relativeToPluginRoot(outfile: string): string {
  const prefix = "deck-plugin/";
  if (!outfile.startsWith(prefix)) {
    throw new Error(`expected an outfile under "${prefix}", got "${outfile}"`);
  }
  return outfile.slice(prefix.length);
}

test("build:hook's ttsr-hook.ts outfile lives under deck-plugin/hooks/", () => {
  const outfile = outfileFor(pkg.scripts["build:hook"]!, "hooks/ttsr-hook.ts");
  expect(relativeToPluginRoot(outfile)).toBe("hooks/ttsr-hook.mjs");
});

test("build:cli's kory-rules.ts outfile lives under deck-plugin/bin/", () => {
  const outfile = outfileFor(pkg.scripts["build:cli"]!, "cli/kory-rules.ts");
  expect(relativeToPluginRoot(outfile)).toBe("bin/kory-rules.mjs");
});

test("build:cli runs as part of the same top-level chains as build:hook (dev/build)", () => {
  for (const chain of ["dev", "build"] as const) {
    const script = pkg.scripts[chain]!;
    expect(script).toContain("npm run build:hook");
    expect(script).toContain("npm run build:cli");
  }
});

test("hooks.json's ttsr-hook command path matches build:hook's ttsr-hook.ts outfile", () => {
  const ttsrOutfile = relativeToPluginRoot(outfileFor(pkg.scripts["build:hook"]!, "hooks/ttsr-hook.ts"));
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON, "utf-8")) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  };
  const commands = [...(hooksJson.hooks.PreToolUse ?? []), ...(hooksJson.hooks.PostToolUse ?? [])]
    .flatMap((entry) => entry.hooks)
    .map((h) => h.command)
    .filter((c) => c.includes("ttsr-hook"));

  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect(command).toBe(`bun "\${CLAUDE_PLUGIN_ROOT}/${ttsrOutfile}"`);
  }
});

test("hooks.json wires ttsr-hook on PreToolUse (Edit|MultiEdit|Write|NotebookEdit|Bash) and PostToolUse (Bash)", () => {
  const hooksJson = JSON.parse(readFileSync(HOOKS_JSON, "utf-8")) as {
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  };
  const pre = (hooksJson.hooks.PreToolUse ?? []).find((e) => e.hooks.some((h) => h.command.includes("ttsr-hook")));
  const post = (hooksJson.hooks.PostToolUse ?? []).find((e) => e.hooks.some((h) => h.command.includes("ttsr-hook")));
  expect(pre?.matcher).toBe("Edit|MultiEdit|Write|NotebookEdit|Bash");
  expect(post?.matcher).toBe("Bash");
});

test("the repo-rules skill's CLI path matches build:cli's kory-rules.ts outfile", () => {
  const cliOutfile = relativeToPluginRoot(outfileFor(pkg.scripts["build:cli"]!, "cli/kory-rules.ts"));
  const skillText = readFileSync(SKILL_MD, "utf-8");

  const allowedToolsMatch = /allowed-tools:\s*(.+)/.exec(skillText);
  expect(allowedToolsMatch).not.toBeNull();
  expect(allowedToolsMatch![1]).toContain(`\${CLAUDE_PLUGIN_ROOT}/${cliOutfile}`);

  // The body's own example invocations must cite the same path, not a
  // hand-typed guess that happens to differ from the declared tool.
  // Any bin/*.mjs reference counts, so a renamed or mistyped bundle is caught.
  const bodyRefs = [...skillText.matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}\/)?(bin\/[\w.-]+\.mjs)/g)];
  expect(bodyRefs.length).toBeGreaterThan(1);
  for (const m of bodyRefs) {
    expect(m[1], `SKILL.md cites ${m[0]}, which is not the CLI bundle build:cli writes`).toBe(cliOutfile);
    expect(m[0], `SKILL.md cites ${m[0]} without the \${CLAUDE_PLUGIN_ROOT} prefix`).toStartWith("${CLAUDE_PLUGIN_ROOT}/");
  }
});

test("repo-rules skill frontmatter declares name and a short trigger description", () => {
  const skillText = readFileSync(SKILL_MD, "utf-8");
  expect(/^name:\s*repo-rules\s*$/m.test(skillText)).toBe(true);
  expect(/^description:\s*.+$/m.test(skillText)).toBe(true);
});
