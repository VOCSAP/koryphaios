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

function ruleBlocks(css: string): { selector: string; body: string }[] {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g), (m) => ({
    selector: m[1]!.trim().replace(/\s+/g, " "),
    body: m[2]!
  }));
}

test("--banner-h is 0 by default and raised only while a status banner is mounted", () => {
  const { text } = readCss();
  expect(ruleBlock(text, ":root")).toMatch(/--banner-h:\s*0(px)?\s*;/);
  const raised = ruleBlock(text, ".app:has(> .status-banner)").match(/--banner-h:\s*(\d+)px/);
  expect(`raised banner height: ${raised?.[1] ?? "absent"}`).toMatch(/^raised banner height: [1-9]\d*$/);
  // A banner taller than the band it reserves would cover the view headers again.
  expect(ruleBlock(text, ".status-banner")).toMatch(/(^|;|\s)height:\s*var\(--banner-h\)/);
  expect(ruleBlock(text, ".app")).toMatch(/padding-top:\s*var\(--banner-h\)/);
});

test("the inbox panel stacks under the modal veil, never over an open modal", () => {
  const { text } = readCss();
  // Every rule whose selector list MENTIONS the class (descendant, compound, :has(), list, media)
  // can set the element's z-index; a whole-selector match would miss every one of them.
  const z = (cls: string): number => {
    const token = new RegExp(`(?<![\\w-])\\.${cls}(?![\\w-])`);
    const setters = ruleBlocks(text).filter((r) => token.test(r.selector) && /(?:^|[;\s])z-index\s*:/.test(r.body));
    expect(setters.map((r) => r.selector), `.${cls}: exactly one rule may set its z-index`).toEqual([`.${cls}`]);
    const value = Number(setters[0]!.body.match(/(?:^|[;\s])z-index:\s*([^;]+);/)?.[1]);
    // NaN compares false both ways, so a lost z-index would otherwise pass or fail for the wrong reason.
    expect(Number.isFinite(value), `no numeric z-index on .${cls}`).toBe(true);
    return value;
  };
  expect(z("inbox-panel"), "the inbox paints unveiled over an open modal and hides its left edge").toBeLessThan(
    z("modal-backdrop")
  );
  const panel = readFileSync(join(SRC, "renderer", "src", "components", "InboxPanel.tsx"), "utf8");
  expect(panel.includes('"inbox-panel'), "InboxPanel.tsx no longer renders .inbox-panel: the scan below reads nothing").toBe(true);
  expect(panel.match(/zIndex|z-index/g) ?? [], "an inline z-index in InboxPanel.tsx outranks the stylesheet ladder").toEqual([]);
});

/**
 * Rules with their enclosing at-rule/nesting preludes, in source order of their closing brace.
 * Braces inside quoted strings are content. Throws on an orphan `}`, an unclosed block or an
 * unterminated string: any of them would otherwise return a silent SUBSET of the sheet.
 */
function cssRules(css: string): { selector: string; body: string; context: string[]; order: number }[] {
  const out: { selector: string; body: string; context: string[]; order: number }[] = [];
  const stack: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      buf += ch;
      if (ch === "\\") buf += css[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      const selector = stack.pop();
      if (selector === undefined) throw new Error(`orphan "}" at offset ${i}`);
      out.push({ selector, body: buf, context: [...stack], order: out.length });
      buf = "";
    } else buf += ch;
  }
  if (quote) throw new Error(`unterminated ${quote} string`);
  if (stack.length > 0) throw new Error(`unclosed block: ${stack.join(" > ")}`);
  return out;
}

/** Every `prop: value` of a rule body, in order (a later one wins). */
function declarations(body: string): { prop: string; value: string }[] {
  return body
    .split(";")
    .map((d) => d.match(/^\s*([\w-]+)\s*:\s*([\s\S]*?)\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ prop: m[1]!.toLowerCase(), value: m[2]! }));
}

const classToken = (cls: string) => new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

const LOCK_WITNESSES: { selector: string; props: string[] }[] = [
  { selector: ".rm-badge-locked", props: ["color", "border-color"] },
  { selector: ".rm-badge-lock-remote", props: ["color", "border-color"] },
  { selector: ".rm-locked-note", props: ["color"] },
  { selector: ".wf-node.is-locked", props: ["border-left-color"] }
];

/** Lock witnesses whose colour is not drawn from --locked, in ANY rule that names them. */
function lockAmberViolations(css: string): string[] {
  const rules = cssRules(css);
  const bad: string[] = [];
  for (const w of LOCK_WITNESSES) {
    // Every class of the witness in the same selector segment, in any order.
    const tokens = w.selector.split(".").filter(Boolean).map(classToken);
    const names = (p: string) => tokens.every((t) => t.test(p));
    const naming = rules.filter((r) => r.selector.split(",").some((p) => names(p.trim())));
    const base = naming.filter((r) => r.context.length === 0 && r.selector.split(",").some((p) => p.trim() === w.selector));
    for (const prop of w.props) {
      const own = base.flatMap((r) => declarations(r.body).filter((d) => d.prop === prop));
      if (own.length === 0) bad.push(`${w.selector} declares no ${prop}`);
    }
    for (const r of naming) {
      for (const d of declarations(r.body)) {
        if (w.props.includes(d.prop) && !d.value.includes("var(--locked)")) bad.push(`${r.selector} { ${d.prop}: ${d.value} }`);
        // A shorthand re-sets the colour the witness property guards.
        if (/^(border|border-left|outline)$/.test(d.prop) && !d.value.includes("var(--locked)") && /#|rgb|hsl|var\(/i.test(d.value)) {
          bad.push(`${r.selector} { ${d.prop}: ${d.value} }`);
        }
      }
    }
  }
  return bad;
}

const PRIO_BADGE = /\.rm-badge(?![\w-])|\.rm-prio-(?:must|should|could|wont)(?![\w-])/;

/**
 * Winning `color` for an element carrying exactly `classes`, by specificity then order. Fails CLOSED:
 * any rule naming .rm-badge or .rm-prio-<p> that this evaluator cannot place (combinator, pseudo,
 * attribute, at-rule, nesting, !important) is returned in `unhandled` instead of being skipped.
 */
function badgeColor(css: string, classes: string[]): { value?: string; unhandled: string[] } {
  let best: { spec: number; order: number; value: string } | undefined;
  const unhandled: string[] = [];
  for (const r of cssRules(css)) {
    const colors = declarations(r.body).filter((d) => d.prop === "color");
    const color = colors.at(-1)?.value;
    if (color === undefined) continue;
    const important = colors.some((d) => /!\s*important/i.test(d.value));
    for (const part of r.selector.split(",").map((s) => s.trim())) {
      const simple = /^(\.[\w-]+)+$/.test(part);
      if (!simple || r.context.length > 0 || important) {
        if (PRIO_BADGE.test(part)) unhandled.push([...r.context, part].join(" > "));
        continue;
      }
      const own = part.slice(1).split(".");
      if (!own.every((c) => classes.includes(c))) continue;
      if (!best || own.length > best.spec || (own.length === best.spec && r.order > best.order)) {
        best = { spec: own.length, order: r.order, value: color };
      }
    }
  }
  return { value: best?.value, unhandled };
}

test("every lock rule takes its amber from --locked, never a raw #e0b341", () => {
  const { text } = readCss();
  expect(lockAmberViolations(text), "a lock witness draws its colour from somewhere other than --locked").toEqual([]);
  // A class segment "lock"/"locked" (.rm-badge-locked, .rm-badge-lock-remote, .is-locked, .row-lock),
  // never "block" or "unlock". A lock rule named without that segment escapes this scan.
  const lockToken = /\.(?:[\w-]*-)?lock(?:ed)?(?![a-z])/;
  const lockRules = ruleBlocks(text).filter((r) => lockToken.test(r.selector));
  const scanned = lockRules.map((r) => r.selector);
  for (const sel of [".rm-badge-locked", ".rm-badge-lock-remote", ".rm-locked-note", ".wf-node.is-locked"]) {
    expect(scanned, `the lock scan no longer reaches ${sel}`).toContain(sel);
  }
  const raw = lockRules.filter((r) => /#e0b341/i.test(r.body)).map((r) => r.selector);
  expect(raw, "a lock rule hardcodes the dark amber, which fails 3:1 on the light theme").toEqual([]);
});

test("the base .rm-badge rule precedes every .rm-badge-* variant", () => {
  // Equal specificity: a variant declared above the base pill loses its colour and border to it.
  const rules = ruleBlocks(readCss().text);
  const base = rules.map((r) => r.selector).indexOf(".rm-badge");
  expect(base, "no .rm-badge base rule found").toBeGreaterThanOrEqual(0);
  const variants = rules.filter((r) => /\.rm-badge-[\w-]/.test(r.selector));
  expect(variants.length, "the variant scan reaches no .rm-badge-* rule").toBeGreaterThan(10);
  const masked = rules.slice(0, base).filter((r) => /\.rm-badge-[\w-]/.test(r.selector)).map((r) => r.selector);
  expect(masked, "these badge variants sit above .rm-badge and render as the dim default pill").toEqual([]);
});

test("the modal priority badge stays grey while the board chip keeps the MoSCoW colour", () => {
  const { text } = readCss();
  expect(badgeColor(text, ["rm-prio-chip", "rm-prio-must"]).value, "the board chip lost its priority colour").toBe("#e05a5a");
  for (const p of ["must", "should", "could", "wont"]) {
    const { value, unhandled } = badgeColor(text, ["rm-badge", `rm-prio-${p}`]);
    expect(unhandled, "these rules may recolour the modal priority badge and the cascade check cannot place them").toEqual([]);
    expect(value, `the modal badge for "${p}" is coloured, not grey`).toBe("var(--fg-dim)");
  }
});

test("the badge and lock colour guards reject a faulty stylesheet", () => {
  const { text } = readCss();
  for (const faulty of [
    "[data-theme='light'] .rm-badge.rm-prio-should { color: #e0b341; }",
    ".rm-detail-badges .rm-prio-should { color: #e0b341; }",
    ".rm-badge.rm-prio-must:hover { color: #e05a5a; }",
    ".rm-prio-could { color: #4f86ff !important; }",
    "@media (min-width: 1px) { .rm-badge.rm-prio-should { color: #e0b341; } }",
    ".rm-badge.rm-prio-should { color: #e0b341 !important; color: var(--fg-dim); }"
  ]) {
    expect(badgeColor(`${text}\n${faulty}`, ["rm-badge", "rm-prio-should"]).unhandled, `not caught: ${faulty}`).not.toEqual([]);
  }
  expect(badgeColor(`${text}\n.rm-badge.rm-prio-should.rm-badge { color: #e0b341; }`, ["rm-badge", "rm-prio-should"]).value).toBe("#e0b341");
  const braceInString = '.rm-badge.rm-prio-should { content: "}"; color: #e0b341; }';
  expect(badgeColor(`${text}\n${braceInString}`, ["rm-badge", "rm-prio-should"]).value, `not caught: ${braceInString}`).toBe("#e0b341");
  expect(() => badgeColor(`${text}\n.rm-badge.rm-prio-should { color: #e0b341;`, ["rm-badge"]), "an unclosed block parsed as a subset").toThrow(/unclosed block/);
  expect(() => badgeColor(`${text}\n}`, ["rm-badge"]), "an orphan brace parsed as a subset").toThrow(/orphan/);
  for (const faulty of [
    ".rm-badge-locked { color: #9a6700; }",
    ".rm-locked-note { color: var(--danger); }",
    "[data-theme='light'] .rm-badge-lock-remote { border-color: #9a6700; }",
    ".wf-node.is-locked { border-left: 3px solid #e0b341; }",
    ".is-locked.wf-node { border-left-color: #e0b341; }"
  ]) {
    expect(lockAmberViolations(`${text}\n${faulty}`), `not caught: ${faulty}`).not.toEqual([]);
  }
  const stripped = text.replace(/(\.rm-locked-note\s*\{[^}]*?)color:\s*var\(--locked\);/, "$1");
  expect(stripped, "the probe no longer finds the .rm-locked-note colour to remove").not.toBe(text);
  expect(lockAmberViolations(stripped)).toContain(".rm-locked-note declares no color");
});

// Per-declaration keys prevent one exemption from masking another violation on the same selector.
const BANNER_EXEMPT: Record<string, string> = {
  ".app { height: 100vh }": "its padding-top IS the reservation; the height stays the whole window",
  ".app-mobile { height: 100vh }": "the mobile shell also carries .app, whose padding-top reserves the band",
  ".app-mobile { height: var(--vvh, 100vh) }": "same shell, visual-viewport height",
  ".help-popup { max-height: calc(100vh - 90px) }": "anchored to the bottom and painted after the banner",
  ".inbox-panel { max-height: calc(100vh - 90px) }": "anchored to the bottom, its top never reaches the band",
  ".status-banner { top: 0 }": "the band itself",
  ".context-menu-backdrop { inset: 0 }": "transparent click catcher at z-index 70, above the banner",
  ".remote-overlay { inset: 0 }": "link-lost overlay at z-index 5000, meant to cover everything",
  ".msheet-backdrop { inset: 0 }": "mobile bottom sheet at z-index 4000, meant to cover everything",
  ".avatar-root .avatar-frame { inset: 0 }": "the avatar window is its own document, which never mounts a status banner"
};

const FULL_VIEWPORT_HEIGHT = /\b100[dsl]?vh\b/;

function bannerCensus(css: string): { violations: string[]; exemptHit: Set<string> } {
  const violations: string[] = [];
  const exemptHit = new Set<string>();
  for (const { selector, body } of ruleBlocks(css)) {
    const decls = body.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean);
    const fixed = decls.some((d) => /^position: ?fixed$/.test(d));
    for (const d of decls) {
      const fullHeight = FULL_VIEWPORT_HEIGHT.test(d) && !d.includes("var(--banner-h)");
      const topEdge = fixed && (/^(inset|top): ?0(px)?$/.test(d) || /^inset: ?0(px)? /.test(d));
      if (!fullHeight && !topEdge) continue;
      const key = `${selector} { ${d} }`;
      if (key in BANNER_EXEMPT) exemptHit.add(key);
      else violations.push(key);
    }
  }
  return { violations, exemptHit };
}

test("the banner census recognises every full viewport height unit and a fixed top edge", () => {
  for (const unit of ["vh", "dvh", "svh", "lvh"]) {
    const { violations } = bannerCensus(`.probe { height: 100${unit}; }`);
    expect(`${unit}: ${violations.length}`).toBe(`${unit}: 1`);
  }
  expect(bannerCensus(".probe { height: calc(100dvh - var(--banner-h)); }").violations).toEqual([]);
  expect(bannerCensus(".probe { position: fixed; top: 0; }").violations).toEqual([".probe { top: 0 }"]);
  expect(bannerCensus(".probe { position: absolute; top: 0; }").violations).toEqual([]);
});

test("every full-height or top-pinned fixed surface reserves the banner band", () => {
  const { text } = readCss();
  const { violations, exemptHit } = bannerCensus(text);
  // Positive control: a scan that parsed nothing would report no violation.
  expect(exemptHit.size).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});

test("every banner exemption still names a declaration that needs it", () => {
  const { text } = readCss();
  expect(Object.keys(BANNER_EXEMPT).length).toBeGreaterThan(0);
  const { exemptHit } = bannerCensus(text);
  const stale = Object.keys(BANNER_EXEMPT).filter((k) => !exemptHit.has(k));
  expect(stale).toEqual([]);
});

test("the mobile shell carries .app, whose padding-top reserves the banner band", () => {
  const app = readFileSync(join(SRC, "renderer", "src", "components", "App.tsx"), "utf8");
  const classLists = Array.from(app.matchAll(/className="([^"]*)"/g), (m) => m[1]!.split(/\s+/));
  const mobile = classLists.filter((c) => c.includes("app-mobile"));
  expect(mobile.length).toBeGreaterThan(0);
  expect(mobile.every((c) => c.includes("app"))).toBe(true);
});

test("a themed :focus-visible ring exists at element level, not per class", () => {
  const { text } = readCss();
  // Element-level so a control written tomorrow inherits it; a per-class fix
  // would leave the next <button> showing Chromium's native ring.
  expect(/(^|\})\s*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/m.test(text)).toBe(
    true
  );
});

// The whole census, global rule and per-surface overrides alike: a new override
// is added here with the reason it may depart from the global look.
const SCROLLBAR_DECLS: string[] = [
  "::-webkit-scrollbar { width: 8px }",
  "::-webkit-scrollbar { height: 8px }",
  "::-webkit-scrollbar-track { background: transparent }",
  "::-webkit-scrollbar-corner { background: transparent }",
  "::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg) 28%, transparent) }",
  "::-webkit-scrollbar-thumb { border-radius: 4px }",
  "::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--fg) 42%, transparent) }",
  // Collapsed agents rail: a bar would eat a third of its width.
  ".sidebar-collapsed .rows::-webkit-scrollbar { width: 0 }",
  ".sidebar-collapsed .rows::-webkit-scrollbar { height: 0 }",
  // Annotation list hides its bar the same way, wheel scrolling kept.
  ".annotate-panel-list::-webkit-scrollbar { display: none }"
];

function decl(raw: string): string | null {
  const d = raw.trim().replace(/\s+/g, " ");
  const colon = d.indexOf(":");
  if (colon < 0) return null;
  return `${d.slice(0, colon).trim().toLowerCase()}: ${d.slice(colon + 1).trim()}`;
}

/** Every declaration of every selector that names a ::-webkit-scrollbar pseudo-element. */
function scrollbarCensus(css: string): string[] {
  const out: string[] = [];
  for (const { selector, body } of ruleBlocks(css)) {
    for (const part of selector.split(",").map((s) => s.trim())) {
      if (!/::-webkit-scrollbar/i.test(part)) continue;
      for (const raw of body.split(";")) {
        const d = decl(raw);
        if (d) out.push(`${part} { ${d} }`);
      }
    }
  }
  return out.sort();
}

// Surfaces whose bar is hidden outright; a new one is added here with its reason.
const SCROLLBAR_HIDDEN: string[] = [
  // Collapsed agents rail: a bar would eat a third of its width.
  ".sidebar-collapsed .rows { scrollbar-width: none }",
  // Annotation list: wheel scrolling kept, bar suppressed.
  ".annotate-panel-list { scrollbar-width: none }"
];

/** `scrollbar-color`, or a `scrollbar-width` other than `none`, makes Chromium drop the pseudo-elements. */
function nativeScrollbarDecls(css: string): { violations: string[]; hidden: string[] } {
  const violations: string[] = [];
  const hidden: string[] = [];
  for (const { selector, body } of ruleBlocks(css)) {
    for (const raw of body.split(";")) {
      const d = decl(raw);
      const m = d?.match(/^scrollbar-(color|width): (.+)$/);
      if (!m) continue;
      const key = `${selector} { ${d} }`;
      if (m[1] === "width" && m[2]!.toLowerCase() === "none") hidden.push(key);
      else violations.push(key);
    }
  }
  return { violations, hidden: hidden.sort() };
}

const RAW_PSEUDO = /::-webkit-scrollbar/gi;
const RAW_STANDARD = /(?<![\w-])scrollbar-(?:color|width)\s*:/gi;

/**
 * The block extractor is a regex and loses a block holding a nested rule or a
 * brace inside a string; this barrier counts the raw occurrences independently,
 * so such a block fails the test instead of leaving the census.
 */
function censusBarrier(css: string): string {
  let pseudo = 0;
  let standard = 0;
  for (const { selector, body } of ruleBlocks(css)) {
    for (const part of selector.split(",")) pseudo += part.match(RAW_PSEUDO)?.length ?? 0;
    for (const raw of body.split(";")) if (/^scrollbar-(color|width):/.test(decl(raw) ?? "")) standard++;
  }
  const rawPseudo = css.match(RAW_PSEUDO)?.length ?? 0;
  const rawStandard = css.match(RAW_STANDARD)?.length ?? 0;
  return `pseudo ${pseudo}/${rawPseudo}, standard ${standard}/${rawStandard}`;
}

test("the scrollbar census sees every pseudo-element rule, whatever its casing or grouping", () => {
  expect(scrollbarCensus(".a, .b::-WEBKIT-SCROLLBAR-thumb { BACKGROUND: red; }")).toEqual([
    ".b::-WEBKIT-SCROLLBAR-thumb { background: red }"
  ]);
  expect(scrollbarCensus("@media (x) { .p::-webkit-scrollbar { width: 12px } }")).toEqual([
    ".p::-webkit-scrollbar { width: 12px }"
  ]);
});

test("the census barrier catches a block the extractor loses", () => {
  expect(censusBarrier(".p::-webkit-scrollbar { width: 3px }")).toBe("pseudo 1/1, standard 0/0");
  expect(censusBarrier(".p::-webkit-scrollbar { @media (x) { width: 3px } }")).toBe("pseudo 0/1, standard 0/0");
  expect(censusBarrier('.p::-webkit-scrollbar { content: "{"; width: 3px }')).toBe("pseudo 0/1, standard 0/0");
  expect(censusBarrier('.p { scrollbar-width: none; content: "{" }')).toBe("pseudo 0/0, standard 0/1");
});

test("the native-scrollbar detector flags the standard properties in any casing and spares none", () => {
  expect(nativeScrollbarDecls(".p { SCROLLBAR-COLOR: red blue; }").violations).toEqual([
    ".p { scrollbar-color: red blue }"
  ]);
  expect(nativeScrollbarDecls(".p { scrollbar-width: thin; }").violations).toEqual([".p { scrollbar-width: thin }"]);
  expect(nativeScrollbarDecls(".p { Scrollbar-Width: NONE; }")).toEqual({
    violations: [],
    hidden: [".p { scrollbar-width: NONE }"]
  });
});

test("every scrollbar occurrence in each Deck stylesheet is seen by the census", () => {
  const { files } = readCss();
  for (const f of files) {
    const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const seen = censusBarrier(css);
    const [, rp, rs] = seen.match(/pseudo \d+\/(\d+), standard \d+\/(\d+)/)!;
    expect(`${f}: ${seen}`).toBe(`${f}: pseudo ${rp}/${rp}, standard ${rs}/${rs}`);
  }
});

test("every scrollbar rule in the Deck stylesheet is the themed global or a listed override", () => {
  const { text } = readCss();
  expect(scrollbarCensus(text)).toEqual([...SCROLLBAR_DECLS].sort());
});

test("no rule brings the native scrollbar back, and only the listed surfaces hide it", () => {
  const { text } = readCss();
  const { violations, hidden } = nativeScrollbarDecls(text);
  expect(violations).toEqual([]);
  expect(hidden).toEqual([...SCROLLBAR_HIDDEN].sort());
});
