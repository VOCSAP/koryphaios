// PLAN C22: snippet store — .md files in global/project dirs, project
// shadowing global on a name collision, guarded delete, size cap.

import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node-only module (no electron / no @shared alias), imports under bun.
import {
  globalSnippetsDir,
  localSnippetsDir,
  listSnippets,
  writeSnippet,
  deleteSnippet,
  MAX_SNIPPET_BYTES,
} from "../desktop/src/main/snippet-store.ts";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "snip-test-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function env(global: string): NodeJS.ProcessEnv {
  return { APPDATA: global, XDG_CONFIG_HOME: global } as NodeJS.ProcessEnv;
}

test("dirs resolve under the app config dir and the project .claude dir", () => {
  const g = tmp();
  expect(globalSnippetsDir(env(g)).replace(/\\/g, "/")).toContain("/snippets");
  const proj = tmp();
  expect(localSnippetsDir(proj).replace(/\\/g, "/")).toContain(".claude/claude-peers/snippets");
});

test("write then list round-trips name and text, sorted by name", () => {
  const g = tmp();
  const proj = tmp();
  writeSnippet(globalSnippetsDir(env(g)), "pause peers", "Pause the peers, I am closing.");
  writeSnippet(globalSnippetsDir(env(g)), "daily recap", "Summarize what you did today.");
  const all = listSnippets(proj, env(g));
  expect(all.map((s) => s.name)).toEqual(["daily-recap", "pause-peers"]);
  expect(all[1]!.text).toBe("Pause the peers, I am closing.");
  expect(all.every((s) => s.source === "global")).toBe(true);
});

test("project snippets come first and shadow a global one with the same name", () => {
  const g = tmp();
  const proj = tmp();
  writeSnippet(globalSnippetsDir(env(g)), "pause", "global version");
  writeSnippet(globalSnippetsDir(env(g)), "only-global", "still visible");
  writeSnippet(localSnippetsDir(proj), "pause", "project version");
  const all = listSnippets(proj, env(g));
  expect(all.map((s) => `${s.source}:${s.name}`)).toEqual([
    "local:pause",
    "global:only-global",
  ]);
  expect(all[0]!.text).toBe("project version");
});

test("empty, oversized and non-md files are skipped", () => {
  const g = tmp();
  const proj = tmp();
  const dir = globalSnippetsDir(env(g));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "empty.md"), "   \n");
  writeFileSync(join(dir, "huge.md"), "x".repeat(MAX_SNIPPET_BYTES + 1));
  writeFileSync(join(dir, "notes.txt"), "not a snippet");
  writeSnippet(dir, "ok", "fine");
  expect(listSnippets(proj, env(g)).map((s) => s.name)).toEqual(["ok"]);
});

test("deleteSnippet only removes .md files inside the two snippet dirs", () => {
  const g = tmp();
  const proj = tmp();
  const inside = writeSnippet(localSnippetsDir(proj), "goner", "bye");
  expect(deleteSnippet(inside, proj, env(g))).toBe(true);
  expect(existsSync(inside)).toBe(false);

  // Outside dir: refused even with the right extension.
  const outside = join(tmp(), "evil.md");
  writeFileSync(outside, "nope");
  expect(deleteSnippet(outside, proj, env(g))).toBe(false);
  expect(existsSync(outside)).toBe(true);

  // Wrong extension inside the dir: refused.
  const dir = localSnippetsDir(proj);
  mkdirSync(dir, { recursive: true });
  const wrongExt = join(dir, "config.json");
  writeFileSync(wrongExt, "{}");
  expect(deleteSnippet(wrongExt, proj, env(g))).toBe(false);
  expect(existsSync(wrongExt)).toBe(true);
});
