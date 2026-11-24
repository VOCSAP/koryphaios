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
  "--mark-color": ["desktop/src/renderer/src/components/BrowserView.tsx"],
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

/**
 * Drops `/* ... *\/` comments, leaving quoted strings whole: a `/*` inside a
 * string is content. Throws on an unterminated comment or string rather than
 * returning a sheet with a hole in it.
 */
function stripCssComments(css: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\") out += css[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unterminated comment at offset ${i}`);
      i = end + 1;
    } else out += ch;
  }
  if (quote) throw new Error(`unterminated ${quote} string`);
  return out;
}

/** Comments are stripped: a token NAMED in a comment is not a consumer. */
function readCss(): { text: string; files: string[] } {
  const files = walk(SRC, [".css"]);
  const text = files.map((f) => stripCssComments(readFileSync(f, "utf8"))).join("\n");
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
  const panel = readFileSync(join(SRC, "renderer", "src", "components", "InboxCore.tsx"), "utf8");
  expect(/["'`]inbox-panel\b/.test(panel), "InboxCore.tsx no longer renders .inbox-panel: the scan below reads nothing").toBe(true);
  expect(panel.match(/zIndex|z-index/g) ?? [], "an inline z-index in InboxCore.tsx outranks the stylesheet ladder").toEqual([]);
});

/**
 * Rules with their enclosing at-rule preludes, in source order of their closing brace.
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
    } else if (ch === "\\") {
      throw new Error(`backslash escape outside a string at offset ${i}: unsupported`);
    } else if (ch === "{") {
      // A rule nested in a rule (CSS nesting) would fold the parent's earlier declarations into this selector.
      const parent = stack.find((s) => !s.startsWith("@"));
      if (parent !== undefined) throw new Error(`nested rule inside "${parent}" at offset ${i}: unsupported, flatten it`);
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

/**
 * Every `prop: value` of a rule body, in order (a later one wins). A `;` inside
 * a quoted string or parentheses (`url("data:...;...")`) is content, not a separator.
 */
function declarations(body: string): { prop: string; value: string }[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += body[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "\\") {
      throw new Error(`backslash escape outside a string: unsupported, in: ${body.trim().slice(0, 80)}`);
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      if (--depth < 0) throw new Error(`unbalanced parentheses in: ${body.trim().slice(0, 80)}`);
      cur += ch;
    } else if (ch === ";" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (quote || depth !== 0) throw new Error(`unbalanced ${quote ? `${quote} string` : "parentheses"} in: ${body.trim().slice(0, 80)}`);
  parts.push(cur);
  return parts
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
    const css = stripCssComments(readFileSync(f, "utf8"));
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

// ----- theme parity and raw hex ----------------------------------------------

/** A theme block: `[data-theme=x]`, optionally on `:root` or `html`, any quoting. */
const THEME_SELECTOR = /^(?::root|html)?\[data-theme=(['"]?)([\w-]+)\1\]$/;

/** Custom properties each theme block declares, merged across every rule naming that theme alone, @media included. */
function themeTokenSets(css: string): Map<string, Set<string>> {
  const themes = new Map<string, Set<string>>();
  for (const r of cssRules(css)) {
    for (const part of r.selector.split(",")) {
      const m = part.trim().match(THEME_SELECTOR);
      if (!m) continue;
      const set = themes.get(m[2]!) ?? new Set<string>();
      for (const d of declarations(r.body)) if (d.prop.startsWith("--")) set.add(d.prop);
      themes.set(m[2]!, set);
    }
  }
  return themes;
}

/** Tokens some theme declares and another does not: the other theme silently inherits :root or nothing. */
function themeParityViolations(css: string): string[] {
  const themes = themeTokenSets(css);
  const all = new Set([...themes.values()].flatMap((s) => [...s]));
  const out: string[] = [];
  for (const [theme, set] of themes) {
    for (const token of all) if (!set.has(token)) out.push(`${token}: missing from the '${theme}' theme`);
  }
  return out.sort();
}

/** #rgb, #rgba, #rrggbb, #rrggbbaa, any case; not a longer word such as an id. */
const RAW_HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/;

/** `<at-rule context > ><selector> :: <property>` for every non-token declaration holding a raw hex colour. */
function rawHexDecls(css: string): string[] {
  const out = new Set<string>();
  for (const r of cssRules(css)) {
    const where = `${r.context.length > 0 ? `${r.context.join(" > ")} > ` : ""}${r.selector}`;
    for (const d of declarations(r.body)) {
      if (!d.prop.startsWith("--") && RAW_HEX.test(d.value)) out.add(`${where} :: ${d.prop}`);
    }
  }
  return [...out].sort();
}

const STATE_HUE = "state or category hue (ok, warn, error, info, attention, directive, priority, diff) written before a semantic token existed for it";
const GREY = "hardcoded grey or terminal surface where DESIGN.md asks for a --bg-*/--fg-* token";
const RESTORE = "the restore orange of DESIGN.md section 2, which has no token yet";
const WHITE_ON_FILL = "white on a filled semantic surface (allowed by DESIGN.md) or the white quiet zone of a QR code, not a token yet";
const AVATAR = "the Avatar frame's own palette, drawn outside the Deck themes";

/** Allowed raw-hex declaration pairs; every entry carries its current design reason. */
const RAW_HEX_EXCEPTIONS: [string, string][] = [
  [".row-drag-over :: box-shadow", STATE_HUE],
  [".row-quota :: color", STATE_HUE],
  [".dot-running :: background", STATE_HUE],
  [".dot-starting :: background", STATE_HUE],
  [".dot-limited :: background", STATE_HUE],
  [".tile-quota :: color", STATE_HUE],
  [".tile-quota :: border", STATE_HUE],
  [".toast-success :: background", STATE_HUE],
  [".toast-success :: border", STATE_HUE],
  [".toast-info :: background", STATE_HUE],
  [".toast-info :: border", STATE_HUE],
  [".toast-error :: background", STATE_HUE],
  [".toast-error :: border", STATE_HUE],
  [".status-banner-error :: background", STATE_HUE],
  [".status-banner-error :: border-bottom", STATE_HUE],
  [".status-banner-warn :: background", STATE_HUE],
  [".status-banner-warn :: border-bottom", STATE_HUE],
  [".field input[type='range'] :: accent-color", STATE_HUE],
  [".template-row-selected :: border-color", STATE_HUE],
  [".template-source-local :: color", STATE_HUE],
  [".template-source-local :: border-color", STATE_HUE],
  [".modal-actions.template-actions button.btn-use :: background", STATE_HUE],
  [".modal-actions.template-actions button.btn-cancel :: background", STATE_HUE],
  [".use-template-btn :: background", STATE_HUE],
  [".sandbox-pill.pithos-stale svg :: color", STATE_HUE],
  [".kind-glyph-feature :: color", STATE_HUE],
  [".kind-glyph-bug :: color", STATE_HUE],
  [".kind-glyph-idea :: color", STATE_HUE],
  [".kind-glyph-chore :: color", STATE_HUE],
  [".kind-glyph-directive :: color", STATE_HUE],
  [".roadmap-error :: color", STATE_HUE],
  [".rm-col-head-planned :: color", STATE_HUE],
  [".rm-col-head-in_progress :: color", STATE_HUE],
  [".rm-col-head-done :: color", STATE_HUE],
  [".rm-card-contested :: border-color", STATE_HUE],
  [".rm-card-contested :: box-shadow", STATE_HUE],
  [".rm-conflict-nobase, .rm-conflict-nodiff :: color", STATE_HUE],
  [".rm-stop-stuck :: color", STATE_HUE],
  [".rm-stop-stragglers :: border", STATE_HUE],
  [".rm-stop-stragglers :: background", STATE_HUE],
  [".rm-stop-stragglers :: color", STATE_HUE],
  [".rm-stop-stragglers h3 :: color", STATE_HUE],
  [".rm-prio-must :: color", STATE_HUE],
  [".rm-prio-should :: color", STATE_HUE],
  [".rm-prio-could :: color", STATE_HUE],
  [".rm-badge-value-high :: color", STATE_HUE],
  [".rm-badge-value-high :: border-color", STATE_HUE],
  [".rm-badge-value-medium :: color", STATE_HUE],
  [".rm-badge-value-medium :: border-color", STATE_HUE],
  [".rm-badge-effort-high :: color", STATE_HUE],
  [".rm-badge-effort-high :: border-color", STATE_HUE],
  [".rm-badge-effort-low :: color", STATE_HUE],
  [".rm-badge-effort-low :: border-color", STATE_HUE],
  [".rm-badge-status-in_progress :: color", STATE_HUE],
  [".rm-badge-status-in_progress :: border-color", STATE_HUE],
  [".rm-badge-status-done :: color", STATE_HUE],
  [".rm-badge-status-done :: border-color", STATE_HUE],
  [".rm-badge-triage-ready-for-agent :: color", STATE_HUE],
  [".rm-badge-triage-ready-for-agent :: border-color", STATE_HUE],
  [".rm-detail-actions .danger :: color", STATE_HUE],
  [".rm-detail-actions .danger :: border-color", STATE_HUE],
  [".wt-row-orphan :: border-color", STATE_HUE],
  [".wt-badge-orphan :: color", STATE_HUE],
  [".wt-badge-orphan :: border-color", STATE_HUE],
  [".dot-attention :: background", STATE_HUE],
  [".row-attention :: color", STATE_HUE],
  [".tile-attention :: color", STATE_HUE],
  [".tile-attention :: border-color", STATE_HUE],
  [".nav-rail-offline-dot :: background", STATE_HUE],
  [".inbox-entry-approval :: border-left-color", STATE_HUE],
  [".inbox-entry-approval .inbox-entry-mark :: color", STATE_HUE],
  [".inbox-entry-approval .inbox-entry-dot :: color", STATE_HUE],
  [".inbox-ack-btn:hover:not(:disabled) :: color", STATE_HUE],
  [".inbox-entry-done :: color", STATE_HUE],
  [".diff-add :: color", STATE_HUE],
  [".diff-del :: color", STATE_HUE],
  [".diff-line-add :: color", STATE_HUE],
  [".diff-line-add :: background", STATE_HUE],
  [".diff-line-del :: color", STATE_HUE],
  [".diff-line-del :: background", STATE_HUE],
  [".diff-line-hunk :: color", STATE_HUE],
  [".journal-kind-quota :: color", STATE_HUE],
  [".journal-kind-attention :: color", STATE_HUE],
  [".journal-kind-checkpoint :: color", STATE_HUE],
  [".wf-node.is-directive :: border-left-color", STATE_HUE],
  [".wf-node.is-directive :: background", STATE_HUE],
  [".wf-node.is-directive:hover :: border-color", STATE_HUE],
  [".rm-badge-directive :: color", STATE_HUE],
  [".rm-badge-directive :: border-color", STATE_HUE],
  [".rm-target-chip.is-on :: border-color", STATE_HUE],
  [".rm-target-chip.is-on :: color", STATE_HUE],
  [".rm-modal-directive .rm-directive-cmd :: color", STATE_HUE],
  [".rm-badge-target :: color", STATE_HUE],
  [".tc-card-lead :: border-color", STATE_HUE],
  [".graph-node.is-assistant :: border-left", STATE_HUE],
  [".graph-node.is-judge :: border-left", STATE_HUE],
  [".mp-provider-warn :: color", STATE_HUE],
  [".mp-star.is-fav :: color", STATE_HUE],
  [".settings-detect.is-ok :: color", STATE_HUE],
  [".settings-detect.is-ok :: border-color", STATE_HUE],
  [".settings-broker-note :: color", STATE_HUE],
  [".companion-error :: color", STATE_HUE],
  [".companion-devices .link-btn :: color", STATE_HUE],
  [".msheet-item-danger :: color", STATE_HUE],
  [".mrm-error :: color", STATE_HUE],
  [".mrm-prio-must :: border-color", STATE_HUE],
  [".mrm-prio-must :: color", STATE_HUE],
  [".mrm-prio-should :: border-color", STATE_HUE],
  [".mrm-prio-should :: color", STATE_HUE],
  [".mrm-prio-could :: border-color", STATE_HUE],
  [".mrm-prio-could :: color", STATE_HUE],
  [".usage-row-pct.is-warn :: color", STATE_HUE],
  [".usage-bar-fill.is-warn :: background", STATE_HUE],
  [".nav-rail-item.usage-ok .nav-rail-icon :: color", STATE_HUE],
  [".nav-rail-item.usage-warn .nav-rail-icon :: color", STATE_HUE],
  [".sandbox-warn :: color", STATE_HUE],
  [".glyph-fill-warn :: fill", STATE_HUE],
  [".rules-badge-pending :: color", STATE_HUE],
  [".rules-badge-pending :: border-color", STATE_HUE],
  [".rules-notice :: border", STATE_HUE],
  [".rules-notice :: color", STATE_HUE],
  [".rules-test-matched :: color", STATE_HUE],
  [".rules-test-timedout :: color", STATE_HUE],
  [".dot-exited :: background", GREY],
  [".companion-devices :: border-top", GREY],
  [".sandbox-auth-term :: background", GREY],
  [".btn.btn-restore :: background", RESTORE],
  [".btn.btn-restore:hover:not(:disabled) :: background", RESTORE],
  [".restore-prev :: background", RESTORE],
  [".modal-actions.template-actions button.btn-apply :: background", RESTORE],
  [".kind-glyph-debt :: color", RESTORE],
  [".rm-badge-effort-medium :: color", RESTORE],
  [".rm-badge-effort-medium :: border-color", RESTORE],
  [".btn.btn-restore :: color", WHITE_ON_FILL],
  [".restore-prev :: color", WHITE_ON_FILL],
  [".toast :: color", WHITE_ON_FILL],
  [".status-banner :: color", WHITE_ON_FILL],
  [".status-banner-action :: color", WHITE_ON_FILL],
  [".status-banner-error .status-banner-action:focus-visible, .status-banner-warn .status-banner-action:focus-visible :: outline-color", WHITE_ON_FILL],
  [".status-banner-warn .status-banner-cta:focus-visible :: outline-color", WHITE_ON_FILL],
  [".template-del :: color", WHITE_ON_FILL],
  [".modal-actions.template-actions button.btn-use :: color", WHITE_ON_FILL],
  [".modal-actions.template-actions button.btn-apply :: color", WHITE_ON_FILL],
  [".modal-actions.template-actions button.btn-cancel :: color", WHITE_ON_FILL],
  [".use-template-btn :: color", WHITE_ON_FILL],
  [".ws-btn-danger :: color", WHITE_ON_FILL],
  [".nav-rail-badge :: color", WHITE_ON_FILL],
  [".review-mark-n :: fill", WHITE_ON_FILL],
  [".annotate-row-mark :: color", WHITE_ON_FILL],
  [".companion-qr :: background", WHITE_ON_FILL],
  ["[data-theme='light'] .sandbox-auth-term :: background", WHITE_ON_FILL],
  [".notif-qr :: background", WHITE_ON_FILL],
  [".avatar-root .avatar-frame :: background", AVATAR],
  [".avatar-root .avatar-frame :: border", AVATAR],
  [".avatar-root[data-frame='normal'] .avatar-frame::before :: background", AVATAR],
  [".avatar-root[data-frame='normal'] .avatar-frame::before :: border-bottom", AVATAR],
  [".avatar-root[data-frame='normal'] .avatar-frame::before :: color", AVATAR],
];

test("the theme parity detector flags a token one theme lacks, in either direction and any quoting", () => {
  const css = `[data-theme='dark'] { --a: #000; --b: #111; } [data-theme="light"] { --a: #fff; --c: #222; } @media (min-width: 1px) { [data-theme=light] { --b: #333; } }`;
  expect(themeParityViolations(css)).toEqual(["--c: missing from the 'dark' theme"]);
  expect(themeParityViolations(`:root[data-theme='dark'] { --x: #000; } html[data-theme='light'] { --y: #fff; }`)).toEqual([
    "--x: missing from the 'light' theme",
    "--y: missing from the 'dark' theme"
  ]);
});

test("every token declared in one theme of the Deck stylesheet is declared in the other", () => {
  const { text } = readCss();
  const themes = themeTokenSets(text);
  expect([...themes.keys()].sort(), "both themes must be found, or parity is checked over nothing").toEqual(["dark", "light"]);
  for (const [theme, set] of themes) expect(set.size, `tokens of the '${theme}' theme`).toBeGreaterThanOrEqual(15);
  expect(themeParityViolations(text), "declare the token in BOTH theme blocks, never in one only").toEqual([]);
});

test("the raw hex detector flags a hex colour in a rule, whatever its case or length, and spares token declarations", () => {
  const css = `.a { color: #ffb26b; --t: #FFB26B; } .b { border: 1px solid #ABC; } @media (max-width: 1px) { .c { background: color-mix(in srgb, #fff 10%, transparent); } } .d { color: var(--accent); } .e { color: #AbCd; } .f { color: #11223344; }`;
  expect(rawHexDecls(css)).toEqual([".a :: color", ".b :: border", ".e :: color", ".f :: color", "@media (max-width: 1px) > .c :: background"]);
});

test("the CSS pipeline keeps a hex the stylesheet syntax could hide, or refuses the sheet", () => {
  // A `;` inside a data URL is not a declaration boundary.
  const svg = `.a { background-image: url("data:image/svg+xml;utf8,<svg fill='#ABC'/>"); }`;
  expect(rawHexDecls(stripCssComments(svg))).toEqual([".a :: background-image"]);
  // Comment delimiters inside strings are content: the color between them is a real declaration.
  const quoted = `.a { content: "/*"; color: #abc; content: "*/"; }`;
  expect(rawHexDecls(stripCssComments(quoted))).toEqual([".a :: color"]);
  // A nested rule would hide its parent's declarations: the parser refuses it instead.
  expect(() => rawHexDecls(stripCssComments(`.a { color: #abc; .b { color: red; } }`))).toThrow("nested rule");
  // An unquoted url() holding a `;` stays one declaration.
  expect(rawHexDecls(stripCssComments(`.a { background-image: url(data:image/svg+xml;utf8,abc#ABC); }`))).toEqual([
    ".a :: background-image"
  ]);
  // An escaped quote does not end its string: the comment-like text after it is content, and the next declaration is seen.
  const escaped = `.a { content: "x\\" /*#ABC*/ y"; color: #DEF; }`;
  expect(stripCssComments(escaped)).toBe(escaped);
  expect(rawHexDecls(stripCssComments(escaped))).toEqual([".a :: color", ".a :: content"]);
});

test("the CSS pipeline refuses a backslash outside a string and a parenthesis closed before it opens", () => {
  expect(() => rawHexDecls(stripCssComments(`.a { background: foo\\;#ABC; }`))).toThrow("backslash escape outside a string");
  expect(() => declarations(`background: foo\\;#ABC`)).toThrow("backslash escape outside a string");
  // An escaped quote in a selector would open a string that swallows the next rule whole.
  expect(() => rawHexDecls(stripCssComments(`.x\\" { color: #ABC; } .y " { }`))).toThrow("backslash escape outside a string");
  expect(() => rawHexDecls(stripCssComments(`.a { background: x)(#ABC; }`))).toThrow("unbalanced parentheses");
});

test("no rule of the Deck stylesheet writes a raw hex colour outside a token declaration, beyond the named exceptions", () => {
  const { text } = readCss();
  const found = rawHexDecls(text);
  const excepted = new Set(RAW_HEX_EXCEPTIONS.map(([where]) => where));
  expect(found.filter((w) => !excepted.has(w)), "use a var(--token) declared in both themes; do not add an exception").toEqual([]);
  expect(
    [...excepted].filter((w) => !found.includes(w)),
    "this exception no longer matches a rule: delete its entry"
  ).toEqual([]);
  expect(RAW_HEX_EXCEPTIONS.length, "an exception is listed twice").toBe(excepted.size);
  expect(
    RAW_HEX_EXCEPTIONS.filter(([, reason]) => reason.trim() === "").map(([where]) => where),
    "these exceptions carry no reason: give each its current design reason"
  ).toEqual([]);
});
