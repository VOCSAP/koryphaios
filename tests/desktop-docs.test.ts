// Reference documentation integrity (desktop/docs): the directory the help
// assistant and the supervisor are pointed at. Guards against a renamed or
// deleted page leaving a dangling link in the index or in cross-references —
// the assistants follow those links at runtime.

import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(import.meta.dir, "..", "desktop", "docs");

function markdownFiles(): string[] {
  return readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
}

/** Local .md link targets of one page (strips #anchors; skips http/https). */
function localLinks(file: string): string[] {
  const text = readFileSync(join(DOCS_DIR, file), "utf-8");
  const out: string[] = [];
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1]!;
    if (/^[a-z]+:\/\//.test(target)) continue;
    const path = target.split("#")[0]!;
    if (path.endsWith(".md")) out.push(path);
  }
  return out;
}

test("the docs directory ships an index and a substantial page set", () => {
  expect(existsSync(join(DOCS_DIR, "README.md"))).toBe(true);
  expect(markdownFiles().length).toBeGreaterThanOrEqual(10);
});

test("every local markdown link in every page resolves to a shipped file", () => {
  for (const file of markdownFiles()) {
    for (const target of localLinks(file)) {
      expect(existsSync(join(DOCS_DIR, target))).toBe(true);
    }
  }
});

test("the index links every non-README page (no orphan documentation)", () => {
  const indexed = new Set(localLinks("README.md"));
  for (const file of markdownFiles()) {
    if (file === "README.md") continue;
    expect(indexed.has(file)).toBe(true);
  }
});
