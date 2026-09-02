// ConfirmDialog.tsx has no native `<dialog>` to trap focus, and `autoFocus` sat
// unconditionally on the Confirm button regardless of tone, so hitting Enter
// right after a danger dialog opened armed the destructive action. Fix moves
// autoFocus to Cancel unconditionally rather than gating by tone, since 23 of
// 25 call sites never pass tone explicitly.
// This is a domain-wide source scan over every .tsx under
// desktop/src/renderer/src, not scoped to ConfirmDialog.tsx, so it also catches
// the pattern reimplemented in a different component.
// extractButtonTags tracks brace depth and string-quote state character by
// character so an arrow function inside the tag (`=>`) is not mistaken for the
// tag's closing `>`.
// Structural blind spot, not fixed: a destructive button styled without a class
// literally containing `danger`, or a class name composed at runtime, is
// invisible to this source-text scan.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const RENDERER_SRC = join(REPO_ROOT, "desktop", "src", "renderer", "src");

// BrowserView.tsx has autoFocus on a primary (non-danger) button in its own
// local dialog, deliberately out of scope. This list only documents that fact
// for the allow-list-honesty test; it never exempts a file from the domain-wide
// scan below.
const DOCUMENTED_NON_DANGER_AUTOFOCUS = new Set(["components/BrowserView.tsx"]);

function listTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTsxFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extracts the raw text of every `<button ...>` opening tag in `source`,
 * respecting brace depth (`{expr}`) and string literals so an arrow
 * function's `=>` inside an attribute never prematurely closes the tag.
 */
function extractButtonTags(source: string): string[] {
  const tags: string[] = [];
  const openRe = /<button(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(source)) !== null) {
    const start = match.index;
    let i = start;
    let braceDepth = 0;
    let quote: string | null = null;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") {
          i++; // skip escaped char
        } else if (c === quote) {
          quote = null;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") {
        braceDepth++;
        continue;
      }
      if (c === "}") {
        braceDepth--;
        continue;
      }
      if (c === ">" && braceDepth === 0 && source[i - 1] !== "=") {
        i++; // include the '>'
        break;
      }
    }
    tags.push(source.slice(start, i));
  }
  return tags;
}

const DANGER_TOKEN_RE = /(^|['"\s-])danger(['"\s:,}\]-]|$)/;

function hasDangerClass(tag: string): boolean {
  if (!/className\s*=/.test(tag)) return false;
  // Test the whole opening tag, not just a captured className value: a
  // non-greedy brace capture stops at the first `}` and misses `danger`
  // sitting past it (`cx({ a: 1 }, 'danger')`), and there is no single
  // capture group shape that also covers object-key shorthand
  // (`{ danger: cond }`) and CSS suffix idioms (`row-btn-danger`) at once.
  // Gating on `className=` presence keeps this from firing on an unrelated
  // word (e.g. an aria-label) in a tag that has no className at all.
  return DANGER_TOKEN_RE.test(tag);
}

function hasAutoFocus(tag: string): boolean {
  return /\bautoFocus\b/.test(tag);
}

describe("no <button className=…danger…> ever carries autoFocus (domain-wide)", () => {
  const files = listTsxFiles(RENDERER_SRC);

  test("scan finds at least one .tsx file (sanity: the scan itself runs)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("ConfirmDialog.tsx's confirm button lost autoFocus, cancel button gained it", () => {
    const file = join(RENDERER_SRC, "components", "ConfirmDialog.tsx");
    const source = readFileSync(file, "utf-8");
    const tags = extractButtonTags(source);
    expect(tags.length).toBe(2);
    const dangerTags = tags.filter(hasDangerClass);
    // The confirm button's className is conditional (`tone === 'neutral' ? …
    // : 'primary danger'`), so it is not always literally "danger" -- assert
    // structurally: neither tag has autoFocus AND danger together, and one
    // tag (cancel) does have autoFocus.
    for (const tag of dangerTags) {
      expect(hasAutoFocus(tag)).toBe(false);
    }
    expect(tags.some(hasAutoFocus)).toBe(true);
  });

  test("BrowserView.tsx's known autoFocus button is confirmed non-danger (allow-list stays honest)", () => {
    const file = join(RENDERER_SRC, "components", "BrowserView.tsx");
    const source = readFileSync(file, "utf-8");
    const tags = extractButtonTags(source);
    const autoFocusTags = tags.filter(hasAutoFocus);
    expect(autoFocusTags.length).toBeGreaterThan(0);
    for (const tag of autoFocusTags) {
      expect(hasDangerClass(tag)).toBe(false);
    }
  });

  test("domain-wide: no danger button anywhere carries autoFocus", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(RENDERER_SRC.length + 1).replace(/\\/g, "/");
      const source = readFileSync(file, "utf-8");
      const tags = extractButtonTags(source);
      for (const tag of tags) {
        if (hasDangerClass(tag) && hasAutoFocus(tag)) {
          offenders.push(`${rel}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("DOCUMENTED_NON_DANGER_AUTOFOCUS entries still exist on disk (no stale exemption)", () => {
    for (const rel of DOCUMENTED_NON_DANGER_AUTOFOCUS) {
      const file = join(RENDERER_SRC, rel);
      expect(() => readFileSync(file, "utf-8")).not.toThrow();
    }
  });
});
