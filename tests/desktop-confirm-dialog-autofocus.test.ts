// Card 3535599d. ConfirmDialog.tsx rendered its modal in a plain
// `<div className="modal-backdrop">` -- no native `<dialog>` element, so
// nothing traps or moves focus into it on open. `autoFocus` sat on the
// CONFIRM button, unconditionally, regardless of `tone`: on a `danger`
// (destructive) dialog, hitting Enter immediately after the dialog opens
// armed the destructive action. 23 of 25 call sites never pass `tone`
// explicitly and so inherited the dangerous default.
//
// Team-lead arbitration (not renegotiable here): move `autoFocus` to the
// Cancel button, unconditionally, for every tone. Pure removal would leave
// focus outside the modal entirely (no `<dialog>` to fall back on); gating
// by `tone` would still leave Enter arming an action on the one call site
// that already passes `tone="neutral"` for zero real benefit, and it would
// make safety depend on a default 23/25 sites never pass explicitly.
//
// THE GUARD IS DOMAIN-WIDE, NOT FILE-SCOPED. A test asserting only "there is
// no `autoFocus` on ConfirmDialog.tsx's confirm button" has a strictly
// narrower reach than its name promises: it would never see a 26th call
// site, or a *different* component, reintroducing the same defect (e.g.
// BrowserView.tsx already has an unrelated local reimplementation of this
// exact modal-actions pattern, deliberately out of scope for this card --
// see the allow-list below). So this test source-scans every .tsx file
// under desktop/src/renderer/src for ANY `<button>` JSX tag that carries
// both a `danger` class token and the `autoFocus` attribute, regardless of
// which component it lives in.
//
// TAG PARSING. A naive `first '>' after '<button'` search breaks on
// `onClick={() => doThing()}` inside the tag -- the `=>` arrow contains a
// literal '>' that is not the tag's closing bracket. `extractButtonTags`
// scans character-by-character, tracking `{...}` brace depth and string
// quote state, and only treats a bare `>` as the tag terminator when it is
// at brace-depth 0, outside a string, and not the second character of `=>`.
// Proven against the real BrowserView.tsx source below (has an arrow
// function inside the tag AND is the intentional exception).
//
// `danger` TOKEN DETECTION (second review pass). The first version captured
// `className={...}` with a non-greedy `\{([\s\S]*?)\}` and matched `danger`
// only inside that capture -- both wrong: the capture stops at the FIRST
// `}` (so `cx({ a: 1 }, 'danger')` never reaches the string literal), and a
// tight border class rejected object-key shorthand (`{ danger: cond }`, the
// `:` right after the word). `hasDangerClass` now tests the token against
// the WHOLE opening tag once a `className=` attribute is confirmed present,
// with a widened border (`['"\s-]` left, `['"\s:,}\]-]` right) that also
// catches CSS suffix idioms already destructive in this repo's stylesheet
// (`row-btn-danger`, `tile-btn-danger`, `ws-btn-danger`,
// `context-menu-item-danger`, `msheet-item-danger`).
//
// STRUCTURAL BLIND SPOT, DOCUMENTED NOT FIXED: this guard is a source-text
// scan, not a JS/CSS evaluator. Two shapes are unreachable by construction
// and will stay green even with the fix above: (1) a destructive button
// styled without any class literally containing `danger` (e.g. an inline
// style or a differently-named class); (2) a class name fully COMPOSED at
// runtime, e.g. `` className={`primary ${tone}`} `` -- no `danger` token
// exists in the source text to find. Closing either requires evaluating the
// component, not scanning its source; out of scope for this guard.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");
const RENDERER_SRC = join(REPO_ROOT, "desktop", "src", "renderer", "src");

// Deliberately out of scope for card 3535599d (team-lead: "je le traite
// separement"): BrowserView.tsx:1173 has `autoFocus` on a `primary`
// (non-danger) button in its own local recording-start dialog. Not a
// `danger` button, so the scan below would not flag it anyway -- this list
// exists to make that fact explicit and checked, not to silence a real hit.
// NEVER USED TO SKIP A FILE in the domain-wide scan below: it is read only
// by the "allow-list stays honest" test, which asserts the entry is in fact
// non-danger. A `danger` button appearing in a listed file still fails the
// domain-wide test -- adding a file here does not exempt it.
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
