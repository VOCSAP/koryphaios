// Card 526665f7: file -> grammar resolution and unified-diff line classification
// for the Deck's two read-only code surfaces (Files viewer, diff colorizer).
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  resolveCodeLang,
  classifyDiffLines,
  planHighlight,
  HIGHLIGHT_MAX_BLOCK_CHARS,
  HIGHLIGHT_MAX_TOTAL_CHARS,
} from "../desktop/src/shared/code-lang.ts";

test("resolveCodeLang maps extensions, case and path style aside", () => {
  expect(resolveCodeLang("src/broker.ts")).toBe("typescript");
  expect(resolveCodeLang("C:\\work\\kory\\desktop\\src\\App.TSX")).toBe("tsx");
  expect(resolveCodeLang("package.json")).toBe("json");
  expect(resolveCodeLang("scripts/build.mjs")).toBe("javascript");
  expect(resolveCodeLang("k8s/deploy.yml")).toBe("yaml");
  expect(resolveCodeLang("android/app/Main.kt")).toBe("kotlin");
  expect(resolveCodeLang("assets/logo.svg")).toBe("xml");
});

test("resolveCodeLang maps exact names and their suffixed variants", () => {
  expect(resolveCodeLang("Dockerfile")).toBe("docker");
  expect(resolveCodeLang("docker/Dockerfile.dev")).toBe("docker");
  expect(resolveCodeLang("Makefile")).toBe("make");
  expect(resolveCodeLang("Cargo.lock")).toBe("toml");
  // package-lock.json is BOTH an exact name and a .json extension; the exact
  // name wins, which is what makes the stem rule safe to add on top.
  expect(resolveCodeLang("package-lock.json")).toBe("json");
});

test("resolveCodeLang falls back on the shebang, and to null otherwise", () => {
  expect(resolveCodeLang("hooks/pre-commit", "#!/usr/bin/env bash")).toBe("shellscript");
  expect(resolveCodeLang("tools/render", "#!/usr/bin/python3")).toBe("python");
  expect(resolveCodeLang("tools/render", "#!/usr/bin/env node")).toBe("javascript");
  // No name, no extension, no shebang: null means "render as plain text",
  // which is what both surfaces did before Shiki existed.
  expect(resolveCodeLang("LICENSE")).toBeNull();
  expect(resolveCodeLang("notes.unknownext")).toBeNull();
  expect(resolveCodeLang("data.bin", "not a shebang")).toBeNull();
  expect(resolveCodeLang("")).toBeNull();
  // A dotfile is a NAME, not an extension: `.gitignore` must not resolve as
  // the "gitignore" extension of an empty-named file.
  expect(resolveCodeLang(".gitignore")).toBeNull();
});

// One extension per grammar in the CodeLang union. A pin per language, because
// a wrong-but-valid mapping (.rs -> "ruby") type-checks, never blanks a screen
// and only shows up as quietly wrong colours nobody reports.
const ONE_PER_LANG: Array<[string, string]> = [
  ["a.ts", "typescript"], ["a.tsx", "tsx"], ["a.js", "javascript"], ["a.jsx", "jsx"],
  ["a.json", "json"], ["a.jsonc", "jsonc"], ["a.yaml", "yaml"], ["a.md", "markdown"],
  ["a.css", "css"], ["a.html", "html"], ["a.py", "python"], ["a.sh", "shellscript"],
  ["a.rs", "rust"], ["a.go", "go"], ["a.java", "java"], ["a.kt", "kotlin"],
  ["a.sql", "sql"], ["a.toml", "toml"], ["a.xml", "xml"], ["a.c", "c"],
  ["a.cpp", "cpp"], ["a.cs", "csharp"], ["a.php", "php"], ["a.rb", "ruby"],
  ["Dockerfile", "docker"], ["Makefile", "make"], ["a.ini", "ini"], ["a.diff", "diff"],
];

test("every grammar in the union is reachable through at least one name", () => {
  for (const [path, lang] of ONE_PER_LANG) expect([path, resolveCodeLang(path)]).toEqual([path, lang]);
  // The pins must cover the union, or a language could be added with no pin.
  expect(new Set(ONE_PER_LANG.map(([, lang]) => lang)).size).toBe(28);
});

const DIFF = [
  "diff --git a/desktop/src/renderer/src/store.ts b/desktop/src/renderer/src/store.ts",
  "index 1111111..2222222 100644",
  "--- a/desktop/src/renderer/src/store.ts",
  "+++ b/desktop/src/renderer/src/store.ts",
  "@@ -10,3 +10,3 @@ export const useDeck = () => {",
  " const before = 1",
  "-const removed: string = 'old'",
  "+const added: string = 'new'",
  "",
  "diff --git a/scripts/setup.py b/scripts/setup.py",
  "--- /dev/null",
  "+++ b/scripts/setup.py",
  "@@ -0,0 +1 @@",
  "+import os",
  "# --- section marker",
].join("\n");

test("classifyDiffLines keeps the historical kinds and their order", () => {
  const kinds = classifyDiffLines(DIFF).map((l) => l.kind);
  expect(kinds).toEqual([
    "meta", "meta", "file", "file", "hunk", "ctx", "del", "add", "ctx",
    "meta", "file", "file", "hunk", "add", "section",
  ]);
});

test("classifyDiffLines tracks the file each hunk belongs to", () => {
  const lines = classifyDiffLines(DIFF);
  expect(lines[6]?.lang).toBe("typescript"); // removed line, TS file
  expect(lines[7]?.lang).toBe("typescript"); // added line, same file
  expect(lines[13]?.lang).toBe("python"); // added line, after the second header
  // `--- /dev/null` must NOT wipe the language of a newly added file.
  expect(lines[13]?.code).toBe("import os");
  // Structural lines carry no code, so nothing tries to tokenise them.
  for (const i of [0, 1, 2, 3, 4, 9, 10, 11, 12, 14]) expect(lines[i]?.code).toBeNull();
});

test("classifyDiffLines strips the marker without touching the raw text", () => {
  const lines = classifyDiffLines(DIFF);
  expect(lines[5]?.code).toBe("const before = 1");
  expect(lines[6]?.code).toBe("const removed: string = 'old'");
  expect(lines[7]?.code).toBe("const added: string = 'new'");
  // The raw line is what the renderer falls back to, so it must stay intact.
  expect(lines[7]?.text).toBe("+const added: string = 'new'");
  // An empty line inside a hunk is context with empty code, not a meta line:
  // classifying it as meta would drop it out of the tokenised run and split
  // the surrounding block in two.
  expect(lines[8]).toEqual({ kind: "ctx", text: "", code: "", lang: "typescript" });
});

test("classifyDiffLines round-trips the input text", () => {
  const text = DIFF + "\n";
  expect(classifyDiffLines(text).map((l) => l.text).join("\n")).toBe(text);
});

// --- Tokenisation budget ------------------------------------------------
//
// The caps bound a SYNCHRONOUS freeze of the whole window, so a later "just
// raise it a bit to colour this one file" is a UI regression, not a tuning
// choice. Every size and every expectation below is a LITERAL: derive them
// from the constants and the test stays green at any value, including absurd
// ones.
test("an oversized block is refused while its neighbours stay coloured", () => {
  // 70000 > the 65536 per-block cap; 1000 is far below it.
  expect(planHighlight([70000])).toEqual([false]);
  expect(planHighlight([1000, 70000, 1000])).toEqual([true, false, true]);
  // Skipping the giant must not spend the budget either, or the tail dies too.
  expect(planHighlight([70000, 1000, 1000])).toEqual([false, true, true]);
});

test("the total budget degrades as a prefix, not all-or-nothing", () => {
  // 5 x 60000 = 300000 > the 262144 total cap: the first four fit, the rest
  // stay plain text. What the operator reads first is what gets coloured.
  expect(planHighlight([60000, 60000, 60000, 60000, 60000])).toEqual([
    true, true, true, true, false,
  ]);
  // Once exhausted, a later SMALL block stays refused: colour holes in the
  // middle of a diff read as corruption, a clean tail reads as a limit.
  expect(planHighlight([60000, 60000, 60000, 60000, 60000, 10])).toEqual([
    true, true, true, true, false, false,
  ]);
  expect(planHighlight([])).toEqual([]);
});

test("the caps stay at the values their measurement justifies", () => {
  // ~4.2 ms per KB in the renderer (Electron 43 / V8): 64 KB is a ~270 ms
  // worst-case freeze and still covers 98.3% of this repo's files. Raising
  // either number is a deliberate act that has to come here first.
  expect(HIGHLIGHT_MAX_BLOCK_CHARS).toBe(65536);
  expect(HIGHLIGHT_MAX_TOTAL_CHARS).toBe(262144);
});

// --- Coverage guard -----------------------------------------------------
//
// PROXY, NOT THE DOMAIN. The Files viewer opens worktrees and live session
// cwds, i.e. arbitrary repositories, so no test can enumerate the languages it
// will actually meet. This scan measures THIS repository only -- the best
// approximation available, and deliberately a weaker claim than "the language
// table is complete". What it does buy: the day this project grows a language
// nobody mapped, the failure is LOUD here instead of a silently plain-text
// viewer. The closed guard lives in the type system, not here: the renderer's
// grammar table is `satisfies Record<CodeLang, ...>`, so a language with no
// grammar cannot compile.
//
// The test OWNS its premise. Both the threshold and the accepted-unmapped list
// are frozen in this file, so neither can drift under the assertion and leave
// it vacuously green: a new extension crossing the threshold fails until
// someone either maps it or writes it down below, on purpose.
const CENSUS_THRESHOLD = 3;
const ACCEPTED_UNMAPPED: Record<string, string> = {
  png: "binary asset, never highlighted",
};
/**
 * The DOMAIN the scan must still cover, not its sensitivity. Raising
 * CENSUS_THRESHOLD to a number that leaves one extension standing would keep
 * every assertion below green while inspecting almost nothing -- measured:
 * threshold 100 left 1 extension and 8 green tests. This floor makes the scan
 * fail when it stops looking, which is the failure mode this repo keeps paying
 * for. 6 is below the 9 extensions that cross the threshold today, so it has
 * room for the repo to shrink honestly, and no room for the guard to.
 */
const CENSUS_MIN_EXTENSIONS_INSPECTED = 6;

test("every extension common in this repo resolves, or is accepted as unmapped", () => {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);

  const counts = new Map<string, number>();
  for (const path of files) {
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = name.slice(dot + 1).toLowerCase();
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  // Guards the guard, twice. First: a census that returns nothing would pass
  // vacuously. Second, and this is the one that matters: the scan must still
  // INSPECT a domain, not just be sensitive on one extension.
  expect(counts.get("ts") ?? 0).toBeGreaterThan(CENSUS_THRESHOLD);
  const inspected = [...counts.values()].filter((n) => n >= CENSUS_THRESHOLD).length;
  expect(inspected).toBeGreaterThanOrEqual(CENSUS_MIN_EXTENSIONS_INSPECTED);

  const missing = [...counts.entries()]
    .filter(([ext, n]) => n >= CENSUS_THRESHOLD && !ACCEPTED_UNMAPPED[ext])
    .filter(([ext]) => resolveCodeLang(`probe.${ext}`) === null)
    .map(([ext, n]) => `${ext} (${n} files)`);

  expect(missing).toEqual([]);
});
