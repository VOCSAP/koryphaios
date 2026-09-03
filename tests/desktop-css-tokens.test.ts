// A naked `var(--x)` on an undeclared token is a live visual defect (the
// property becomes unset/transparent); a clothed `var(--x, fallback)` is naming
// debt only, since every site renders the fallback.
// The runtime side is an explicit allow-list, not a regex sweep: a regex sweep
// whitelists a token merely mentioned in a comment and misreports tokens
// legitimately fed from TypeScript. Each entry is checked for the actual
// injection call, not just the name, since a dead constant would otherwise keep
// a zombie entry alive.
// Two injection mechanisms are recognized: style.setProperty and a JSX style
// object key; a token written from a runtime string template is not covered.

import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "desktop", "src");

/** Custom properties injected from TypeScript, with EVERY file that injects each. */
const RUNTIME_TOKENS: Record<string, string[]> = {
  "--vvh": ["desktop/src/renderer/src/components/App.tsx"],
  "--tile-color": [
    "desktop/src/renderer/src/components/TerminalTile.tsx",
    "desktop/src/renderer/src/components/BrowserView.tsx"
  ],
  "--chip-color": ["desktop/src/renderer/src/components/MobileAgents.tsx"]
};

/** True when `file` actually INJECTS `token`, by either mechanism. */
function injects(source: string, token: string): boolean {
  const q = `['"]${token}['"]`;
  return new RegExp(`setProperty\\(\\s*${q}`).test(source) || new RegExp(`${q}\\s*:`).test(source);
}

/** Undeclared-but-clothed tokens knowingly tolerated. Empty on purpose. */
const TOLERATED_CLOTHED: string[] = [];

function walk(dir: string, ext: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "out" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** Comments are stripped: a token NAMED in a comment is not a consumer. */
function readCss(): { text: string; files: string[] } {
  const files = walk(SRC, [".css"]);
  const text = files
    .map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""))
    .join("\n");
  return { text, files };
}

function scan() {
  const { text, files } = readCss();
  const declared = new Set(Array.from(text.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]!));
  const naked = new Set<string>();
  const clothed = new Set<string>();
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    (m[2] ? clothed : naked).add(m[1]!);
  }
  return { declared, naked, clothed, files };
}

test("the CSS scan actually reaches the stylesheet (positive control)", () => {
  const { declared, naked, clothed, files } = scan();
  // Without this, every assertion below would pass on an empty scan.
  expect(files.length).toBeGreaterThan(0);
  expect(declared.size).toBeGreaterThan(20);
  expect(naked.size + clothed.size).toBeGreaterThan(20);
  expect(declared.has("--accent")).toBe(true);
});

test("no custom property is consumed WITHOUT a fallback while undeclared", () => {
  const { declared, naked } = scan();
  const dead = [...naked].filter((t) => !declared.has(t) && !(t in RUNTIME_TOKENS));
  // `background: var(--x)` on an undeclared --x computes to transparent.
  expect(dead.sort()).toEqual([]);
});

test("no custom property is consumed WITH a fallback while undeclared", () => {
  const { declared, clothed } = scan();
  const debt = [...clothed].filter(
    (t) => !declared.has(t) && !(t in RUNTIME_TOKENS) && !TOLERATED_CLOTHED.includes(t)
  );
  // Not a visual defect, but it is how --mono spread to 16 selectors unnoticed.
  expect(debt.sort()).toEqual([]);
});

test("every runtime-supplied token is still INJECTED by each file that claims it", () => {
  for (const [token, files] of Object.entries(RUNTIME_TOKENS)) {
    for (const rel of files) {
      // readFileSync throws on a moved file: an entry pointing nowhere must be
      // loud, not skipped. An entry that outlives its injection would otherwise
      // keep whitelisting a token nothing feeds any more.
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(`${token} <- ${rel}: ${injects(src, token)}`).toBe(`${token} <- ${rel}: true`);
    }
  }
});

test("the monospace face is declared once and nothing hardcodes a stack", () => {
  const { text, files } = readCss();
  expect(files.length).toBeGreaterThan(0);
  // Four mutually inconsistent stacks used to coexist; --mono is the arbitration.
  const hardcoded = text
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => /font-family:[^;]*monospace/.test(l) && !/var\(--mono/.test(l))
    .map(([i, l]) => `${i}: ${l.trim()}`);
  expect(hardcoded).toEqual([]);
  expect(/--mono:\s*ui-monospace/.test(text)).toBe(true);
});

/**
 * Exact-selector block extractor, keyed on the SELECTOR STRING, not on a
 * containing/token search: `.wf-lane.is-collapsed` or `.wf-resize:hover`
 * must never match a lookup for `.wf-lane` / `.wf-resize`. Fails LOUD (throws)
 * when the selector isn't found rather than matching an empty string, so a
 * rename or a moved rule breaks this test instead of silently degrading the
 * guard to "nothing to check" (same fail-closed discipline as `injects()`
 * above).
 */
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`selector not found: ${selector}`);
  return m[1]!;
}

test("the workflow lane resize handle (card ba3d2456) stays positioned on the frame's top edge", () => {
  // Without `.wf-lane { position: relative }`, `.wf-resize`'s `position:
  // absolute` promotes to the nearest ancestor containing block instead of the
  // panel, producing a resize band across the whole window's top edge rather
  // than the frame's.
  const { text } = readCss();
  expect(ruleBlock(text, ".wf-lane")).toMatch(/position:\s*relative/);
  const resize = ruleBlock(text, ".wf-resize");
  expect(resize).toMatch(/position:\s*absolute/);
  expect(resize).toMatch(/top:\s*0/);
});

test("a themed :focus-visible ring exists at element level, not per class", () => {
  const { text } = readCss();
  // Element-level so a control written tomorrow inherits it; a per-class fix
  // would leave the next <button> showing Chromium's native ring.
  expect(/(^|\})\s*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/m.test(text)).toBe(
    true
  );
});
