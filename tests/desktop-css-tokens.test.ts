// Wiring guard for the Deck's CSS custom properties (cards e15cbf51, 14c97805).
//
// WHY THIS EXISTS. `--bg-1` was consumed by 7 selectors and declared nowhere for
// 20 days. `background: var(--bg-1)` on an undeclared token is invalid at
// computed-value time, so the property becomes `unset` = transparent: the git
// target cards, both Explorer/Git hover states, the code pane, its sticky line
// gutter and the diff block all rendered with no background at all, and nothing
// went red. The root cause was measured (`git log -S`) and it is not a rename:
// three successive view-additions each copied the token from the previous view,
// so patching the sites closes nothing -- a fourth view copying the third
// reintroduces it. THIS test is the deliverable, the CSS edit is the cleanup.
//
// TWO KINDS OF UNDECLARED TOKEN, opposite gravity, hence two assertions:
//   NAKED   `var(--x)`            -> live visual defect, the property dies.
//   CLOTHED `var(--x, fallback)`  -> naming debt only, every site renders the
//                                    fallback and nothing is broken on screen.
// `--mono` was the clothed case: 16 selectors asked for a token that never
// existed while 10 others hardcoded four inconsistent stacks.
//
// COVERAGE, since a guard that only proves its own sensitivity is the failure
// this repo keeps shipping:
//   - the CSS side ENUMERATES *.css under desktop/src rather than naming
//     styles.css, so a second stylesheet is covered the day it appears;
//   - the runtime side is an explicit ALLOW-LIST, not a regex sweep of the .tsx
//     tree. A regex sweep fails OPEN (a token mentioned in a comment would
//     whitelist itself, and 3 of the 5 undeclared tokens are legitimately fed
//     from TypeScript, so a naive CSS-only guard reports 60% false positives).
//     The allow-list fails CLOSED: a token fed from TypeScript is reported until
//     someone declares it here, next to every file that supplies it;
//   - each allow-list entry is CHECKED against its supplier files, and checked
//     for the INJECTION, not for the name. Naming the token was the first version
//     of this test and it was itself fail-open: a dead constant or a doc string
//     would have kept a zombie entry alive, whitelisting a now-dead token.
// TWO injection mechanisms exist in this tree and both are accepted, because
// only one of the three entries uses the one people name first:
//   `style.setProperty('--vvh', …)`            App.tsx
//   `style={{ '--tile-color': … }}` (JSX key)  TerminalTile.tsx, BrowserView.tsx
// NOT covered, deliberately: tokens written from a string template built at
// runtime, and any stylesheet outside desktop/src. One known fragility: comments
// are stripped by regex, so a literal holding an unbalanced `/*` (none today,
// checked in `url()` and `content:`) would make the scan swallow the rest of the
// file and SHRINK in silence -- the failure this repo has already paid for once.

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
  // ba3d2456 was found fully, silently revertible: reverting both files of
  // the lot to HEAD left tests/desktop-workflow.test.ts at 55/55, because
  // that suite only imports desktop/src/shared/workflow.ts and never reads
  // JSX or CSS. Without `.wf-lane { position: relative }`, `.wf-resize`'s
  // `position: absolute` promotes to the nearest ANCESTOR containing block
  // instead -- a 6px `row-resize` band across the top of the whole window,
  // not the panel's own top frame bar.
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
