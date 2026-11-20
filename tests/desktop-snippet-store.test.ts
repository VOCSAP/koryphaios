// PLAN C22: snippet store — .md files in global/project dirs, project
// shadowing global on a name collision, guarded delete, size cap.

import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onDeckError } from "../desktop/src/main/log.ts";
import { MAX_TRACED_FILES, MAX_TRACED_PER_SCAN } from "../desktop/src/main/project-files.ts";

// Node-only module (no electron / no @shared alias), imports under bun.
import {
  globalSnippetsDir,
  localSnippetsDir,
  localSnippetDirs,
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
  expect(localSnippetsDir(proj).replace(/\\/g, "/")).toContain(".claude/koryphaios/snippets");
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

const koryphaiosDir = (proj: string): string => join(proj, ".claude", "koryphaios", "snippets");
const legacyDir = (proj: string): string => join(proj, ".claude", "claude-peers", "snippets");

function traced(run: () => void): string[] {
  const texts: string[] = [];
  onDeckError((_scope, text) => texts.push(text));
  try {
    run();
  } finally {
    onDeckError(() => {});
  }
  return texts;
}

test("snippets are created under koryphaios and read from koryphaios then claude-peers", () => {
  const proj = tmp();
  expect(localSnippetsDir(proj)).toBe(koryphaiosDir(proj));
  expect(localSnippetDirs(proj)).toEqual([koryphaiosDir(proj), legacyDir(proj)]);
  expect(writeSnippet(localSnippetsDir(proj), "fresh", "text")).toBe(join(koryphaiosDir(proj), "fresh.md"));
});

test("a snippet name is listed once, from koryphaios before claude-peers before global", () => {
  const g = tmp();
  const proj = tmp();
  writeSnippet(globalSnippetsDir(env(g)), "a-all", "global");
  writeSnippet(globalSnippetsDir(env(g)), "b-old-and-global", "global");
  writeSnippet(globalSnippetsDir(env(g)), "c-global-only", "global");
  writeSnippet(legacyDir(proj), "a-all", "legacy");
  writeSnippet(legacyDir(proj), "b-old-and-global", "legacy");
  writeSnippet(legacyDir(proj), "d-old-only", "legacy");
  writeSnippet(koryphaiosDir(proj), "a-all", "koryphaios");
  writeSnippet(koryphaiosDir(proj), "e-new-only", "koryphaios");
  expect(listSnippets(proj, env(g)).map((s) => s.source + ":" + s.name + ":" + s.text)).toEqual([
    "local:a-all:koryphaios",
    "local:b-old-and-global:legacy",
    "local:d-old-only:legacy",
    "local:e-new-only:koryphaios",
    "global:c-global-only:global",
  ]);
});

test("deleteSnippet removes the exact snippet chosen in either local folder and refuses a sibling folder", () => {
  const g = tmp();
  const proj = tmp();
  const fresh = writeSnippet(koryphaiosDir(proj), "same", "from koryphaios");
  const old = writeSnippet(legacyDir(proj), "same", "from claude-peers");
  expect(deleteSnippet(fresh, proj, env(g))).toBe(true);
  expect(listSnippets(proj, env(g)).map((s) => s.text)).toEqual(["from claude-peers"]);
  expect(deleteSnippet(old, proj, env(g))).toBe(true);
  expect(listSnippets(proj, env(g))).toEqual([]);

  const sibling = writeSnippet(join(proj, ".claude", "other", "snippets"), "x", "keep");
  expect(deleteSnippet(sibling, proj, env(g))).toBe(false);
  expect(existsSync(sibling)).toBe(true);
});

test("deleteSnippet removes a global snippet", () => {
  const g = tmp();
  const proj = tmp();
  const path = writeSnippet(globalSnippetsDir(env(g)), "gone", "bye");
  expect(deleteSnippet(path, proj, env(g))).toBe(true);
  expect(existsSync(path)).toBe(false);
});

const canLink = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "snip-link-"));
  try {
    mkdirSync(join(probe, "d"));
    symlinkSync(join(probe, "d"), join(probe, "dl"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

test.skipIf(!canLink)("deleteSnippet refuses a local snippets folder that links out of the project and keeps the file there (needs symlinkSync)", () => {
  const g = tmp();
  const outside = tmp();
  const victim = writeSnippet(outside, "victim", "keep");
  const proj = tmp();
  mkdirSync(join(proj, ".claude", "koryphaios"), { recursive: true });
  symlinkSync(outside, koryphaiosDir(proj), "junction");
  let deleted: boolean | undefined;
  const texts = traced(() => {
    deleted = deleteSnippet(join(koryphaiosDir(proj), "victim.md"), proj, env(g));
  });
  expect(deleted).toBe(false);
  expect(existsSync(victim), "the file behind the link must survive").toBe(true);
  expect(texts.some((text) => text.includes("the snippets folder resolves outside the project")), "the refusal left no trace").toBe(true);
});

test.skipIf(!canLink)("deleteSnippet removes a snippet through a link that stays inside the project (needs symlinkSync)", () => {
  const g = tmp();
  const proj = tmp();
  const inside = join(proj, "shared-snippets");
  const file = writeSnippet(inside, "x", "bye");
  mkdirSync(join(proj, ".claude", "koryphaios"), { recursive: true });
  symlinkSync(inside, koryphaiosDir(proj), "junction");
  expect(deleteSnippet(join(koryphaiosDir(proj), "x.md"), proj, env(g))).toBe(true);
  expect(existsSync(file)).toBe(false);
});

test("listSnippets traces a snippet it cannot read once per signature and ignores the absent folders", () => {
  const g = tmp();
  const proj = tmp();
  const dir = legacyDir(proj);
  writeSnippet(dir, "ok", "fine");
  const unreadable = join(dir, "unreadable.md");
  mkdirSync(unreadable);
  const texts = traced(() => {
    expect(listSnippets(proj, env(g)).map((s) => s.name)).toEqual(["ok"]);
    expect(listSnippets(proj, env(g)).map((s) => s.name)).toEqual(["ok"]);
  });
  expect(texts.filter((text) => text.includes(unreadable))).toHaveLength(1);
  expect(texts.filter((text) => !text.includes(unreadable))).toEqual([]);
});

test("a folder of more unreadable snippets than the trace cap costs one trace per file up to the budget, one line for the rest, and nothing on the next listing", () => {
  const g = tmp();
  const proj = tmp();
  const dir = legacyDir(proj);
  for (let index = 0; index < MAX_TRACED_FILES + 1; index++) mkdirSync(join(dir, "junk-" + index + ".md"), { recursive: true });
  const first = traced(() => { listSnippets(proj, env(g)); });
  expect(first).toHaveLength(MAX_TRACED_PER_SCAN + 1);
  expect(first.filter((text) => text.includes(MAX_TRACED_FILES + 1 - MAX_TRACED_PER_SCAN + " more invalid files"))).toHaveLength(1);
  expect(traced(() => { listSnippets(proj, env(g)); }), "the second listing traces nothing").toEqual([]);
});

test("the same unreadable snippets read in another order trace nothing again", () => {
  const g = tmp();
  const proj = tmp();
  const dir = legacyDir(proj);
  for (let index = 0; index < 2 * MAX_TRACED_PER_SCAN + 4; index++) mkdirSync(join(dir, "junk-" + index + ".md"), { recursive: true });
  expect(traced(() => { listSnippets(proj, env(g)); })).toHaveLength(MAX_TRACED_PER_SCAN + 1);
  const reversed = (folder: string): string[] => readdirSync(folder).reverse();
  expect(traced(() => { listSnippets(proj, env(g), reversed); })).toEqual([]);
});

test("listSnippets stays silent about a snippet that vanished after the folder was listed", () => {
  const g = tmp();
  const proj = tmp();
  const texts = traced(() => {
    expect(listSnippets(proj, env(g), () => ["ghost.md"])).toEqual([]);
  });
  expect(texts).toEqual([]);
});

test("listSnippets traces a folder it cannot read once, and stays silent about an absent folder", () => {
  const g = tmp();
  const proj = tmp();
  const unreadable = legacyDir(proj);
  const readDir = (dir: string): string[] => {
    throw Object.assign(new Error(dir === unreadable ? "denied" : "absent"), {
      code: dir === unreadable ? "EACCES" : "ENOENT",
    });
  };
  const texts = traced(() => {
    expect(listSnippets(proj, env(g), readDir)).toEqual([]);
    expect(listSnippets(proj, env(g), readDir)).toEqual([]);
  });
  expect(texts.filter((text) => text.includes(unreadable))).toHaveLength(1);
  expect(texts.filter((text) => !text.includes(unreadable))).toEqual([]);
});
