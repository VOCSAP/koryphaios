import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// i18n.ts only imports node builtins (no electron), so it imports cleanly under
// bun. Covers interpolation, missing-key/param fallbacks, dir layering, OS-locale
// resolution, and the en.json <-> EN_DEFAULTS parity guard.
import {
  EN_DEFAULTS,
  loadDict,
  resolveLocale,
  t,
} from "../desktop/src/main/i18n.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cp-i18n-"));
  tmpDirs.push(d);
  return d;
}

const DESKTOP_SRC = join(import.meta.dir, "..", "desktop", "src");

// ----- t() interpolation -----

test("t interpolates {placeholder} params", () => {
  const dict = { greet: "Hello {name}, you have {n} messages" };
  expect(t(dict, "greet", { name: "Ada", n: 3 })).toBe(
    "Hello Ada, you have 3 messages",
  );
});

test("t returns the raw key when the key is missing", () => {
  expect(t({}, "nope.missing")).toBe("nope.missing");
});

test("t leaves a {placeholder} verbatim when its param is not supplied", () => {
  const dict = { tpl: "a {known} b {unknown}" };
  expect(t(dict, "tpl", { known: "X" })).toBe("a X b {unknown}");
});

// ----- resolveLocale() -----

test("resolveLocale: explicit en/fr config wins", () => {
  expect(resolveLocale("fr", "en-US")).toBe("fr");
  expect(resolveLocale("en", "fr-FR")).toBe("en");
});

test("resolveLocale: empty (auto) derives from OS locale", () => {
  expect(resolveLocale("", "fr-CA")).toBe("fr");
  expect(resolveLocale("", "en-GB")).toBe("en");
  expect(resolveLocale("", "de-DE")).toBe("en"); // unsupported OS -> en
});

test("resolveLocale: unsupported config tag falls back to OS", () => {
  expect(resolveLocale("es", "fr-FR")).toBe("fr");
});

// ----- loadDict() layering & fallbacks -----

test("loadDict falls back to embedded EN when no files exist", () => {
  const dict = loadDict("fr", [freshDir()]);
  // No fr.json on disk -> the embedded English value stands in.
  expect(dict["common.save"]).toBe(EN_DEFAULTS["common.save"]);
});

test("loadDict: user-override dir wins over the shipped dir", () => {
  const shipped = freshDir();
  const user = freshDir();
  writeFileSync(join(shipped, "fr.json"), JSON.stringify({ "common.save": "Enregistrer" }));
  writeFileSync(join(user, "fr.json"), JSON.stringify({ "common.save": "OVERRIDE" }));
  const dict = loadDict("fr", [shipped, user]);
  expect(dict["common.save"]).toBe("OVERRIDE");
});

test("loadDict: a key present in en but absent in fr falls back to en", () => {
  const shipped = freshDir();
  // fr provides only one key; everything else must fall back to embedded en.
  writeFileSync(join(shipped, "fr.json"), JSON.stringify({ "common.save": "Enregistrer" }));
  const dict = loadDict("fr", [shipped]);
  expect(dict["common.save"]).toBe("Enregistrer");
  expect(dict["common.cancel"]).toBe(EN_DEFAULTS["common.cancel"]); // en fallback
});

test("loadDict: malformed JSON is ignored, embedded defaults survive", () => {
  const shipped = freshDir();
  writeFileSync(join(shipped, "fr.json"), "{ this is not json");
  const dict = loadDict("fr", [shipped]);
  expect(dict["common.save"]).toBe(EN_DEFAULTS["common.save"]);
});

// ----- parity guard: en.json must mirror EN_DEFAULTS -----

test("en.json key set is identical to EN_DEFAULTS", async () => {
  const enPath = join(import.meta.dir, "..", "desktop", "locales", "en.json");
  const enJson = (await Bun.file(enPath).json()) as Record<string, string>;
  expect(Object.keys(enJson).sort()).toEqual(Object.keys(EN_DEFAULTS).sort());
  // Values must match too -- en.json is the shipped copy of the embedded base.
  for (const k of Object.keys(EN_DEFAULTS)) {
    expect(enJson[k]).toBe(EN_DEFAULTS[k]);
  }
});

test("fr.json key set is identical to en.json (no missing/extra keys)", async () => {
  const dir = join(import.meta.dir, "..", "desktop", "locales");
  const en = (await Bun.file(join(dir, "en.json")).json()) as Record<string, string>;
  const fr = (await Bun.file(join(dir, "fr.json")).json()) as Record<string, string>;
  expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
});

// ----- emoji-free gate: no pictograph/emoji code points in any locale source -----
// Card d5b7d842: DESIGN.md bans emoji in the UI outright (every icon is an SVG
// glyph from components/icons.tsx) -- this is the regression gate that keeps
// that rule enforced on the 3 sources that actually ship user-facing strings
// (EN_DEFAULTS, en.json, fr.json; i18n.ts's EN_DEFAULTS is exercised via the
// already-imported object rather than re-reading the .ts source as text).
//
// This is a BLOCKING gate for the whole team, so the range list is
// deliberately biased toward false negatives (miss a rare emoji) over false
// positives (flag legitimate typography and block everyone's commit). It
// intentionally does NOT cover the arrows block (U+2190-U+21FF, used by
// notifications.help.discord's "->" navigation prose), em/en dashes, curly
// quotes/guillemets, or full-width punctuation (e.g. composer.new's "+" --
// FULLWIDTH PLUS SIGN, a deliberate decorative convention, not an emoji).
const EMOJI_RANGES: Array<[number, number]> = [
  [0x1f000, 0x1faff], // mahjong/domino/playing cards, enclosed alphanumeric supplement (🆕🆗🅰), misc pictographs, emoticons, transport, supplemental symbols
  [0x2600, 0x26ff], // misc symbols (warning triangle, sun, umbrella, ...)
  [0x2700, 0x27bf], // dingbats (checkmarks, scissors, ...)
  [0x2300, 0x23ff], // misc technical (hourglass, stopwatch, playback glyphs)
  [0x25a0, 0x25ff], // geometric shapes (play/stop triangles and squares)
  [0x2b00, 0x2bff], // misc symbols and arrows (stars, NOT the plain arrows block)
  [0x1f1e6, 0x1f1ff], // regional indicators (flag letters)
  [0xfe0f, 0xfe0f], // variation selector-16 (forces emoji presentation)
];

function hasEmoji(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
}

function findEmojiKeys(sourceName: string, dict: Record<string, string>): string[] {
  return Object.entries(dict)
    .filter(([, v]) => hasEmoji(v))
    .map(([k]) => `${sourceName}:${k}`);
}

// Purged in full by card d5b7d842 -- starts empty, and must only ever stay
// empty: a future emoji re-introduced anywhere in these 3 sources is a UI
// regression against DESIGN.md, not something to baseline away.
const KNOWN_EMOJI_KEYS: string[] = [];

test("no locale source (EN_DEFAULTS, en.json, fr.json) contains an emoji/pictograph code point", async () => {
  const dir = join(import.meta.dir, "..", "desktop", "locales");
  const en = (await Bun.file(join(dir, "en.json")).json()) as Record<string, string>;
  const fr = (await Bun.file(join(dir, "fr.json")).json()) as Record<string, string>;
  const hits = [
    ...findEmojiKeys("EN_DEFAULTS", EN_DEFAULTS),
    ...findEmojiKeys("en.json", en),
    ...findEmojiKeys("fr.json", fr),
  ];
  expect(hits.sort()).toEqual([...KNOWN_EMOJI_KEYS].sort());
});

test("the emoji gate itself flags a pictograph -- proves it is load-bearing", () => {
  expect(hasEmoji("Queue for dispatch")).toBe(false);
  expect(hasEmoji("⏳ Queue for dispatch")).toBe(true); // U+23F3 HOURGLASS WITH FLOWING SAND
});

test("the emoji gate does not flag legitimate typography (arrows, dashes, full-width punctuation)", () => {
  expect(hasEmoji("Developer Portal → your app → Bot")).toBe(false); // U+2192 RIGHTWARDS ARROW
  expect(hasEmoji("Working tree clean — nothing to review.")).toBe(false); // U+2014 EM DASH
  expect(hasEmoji("＋ New template")).toBe(false); // U+FF0B FULLWIDTH PLUS SIGN
  expect(hasEmoji("« {title} »")).toBe(false); // guillemets
});

// ----- source-wide pictograph gate: no emoji/pictograph code point anywhere
// in desktop/src -----
// Card d5b7d842 CHANGES round (reviewer desktop-7b2civn-koryphaios-11): the
// gate above only covers the 3 sources that ship TRANSLATED strings -- it
// says nothing about a pictograph typed directly into a .tsx literal (e.g.
// ModelPicker's provider glyphs, Sidebar's branch/attention badges) or left
// in a comment (e.g. RoadmapView.tsx's "⏹ Stop button" note). This gate
// closes that gap by scanning every .ts/.tsx file's raw text under
// desktop/src for the same EMOJI_RANGES code points.
//
// Scope is desktop/src, NOT desktop/** -- desktop/dist/win-unpacked ships a
// full copy of built resources (locale JSON, bundled assets) that is not
// source and would double-count/pollute the baseline with build artefacts.
// i18n.ts IS included here (unlike collectDesktopSrcFiles's orphan-key scan
// below, whose skip of i18n.ts is specific to that different check -- a
// pictograph typed into EN_DEFAULTS belongs in this gate too).
//
// The scan is file-TEXT level: it cannot distinguish rendered output from a
// comment or a string literal, so the baseline is named for what it actually
// knows (a pictograph found in the source text), not for where it lands
// on screen.

function collectAllDesktopSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectAllDesktopSrcFiles(full));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Keyed by "relative/path U+XXXX", not file:line: a line number shifts on
// every unrelated edit to a large file (ModelPicker.tsx, Sidebar.tsx are
// both several hundred lines), which would fail this gate on pure noise
// with no pictograph having moved. Path + code point is stable across any
// edit that doesn't touch the pictograph itself, and still pinpoints
// exactly which file+character combination is baselined. Deduped: a
// pictograph repeated several times in one file produces a single entry.
function findSourcePictographs(root: string, files: string[]): string[] {
  const hits = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    const rel = f.slice(root.length + 1).split(sep).join("/");
    for (const ch of src) {
      const cp = ch.codePointAt(0)!;
      if (EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
        hits.add(`${rel} U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
  }
  return [...hits];
}

// Snapshot of the desktop/src tree as of this gate's introduction (card
// d5b7d842 CHANGES round). Card b72b82f7 (2026-07-29) drew SVG glyphs for
// ModelPicker's 5 provider sigils, the graph-chat node/timeline
// provider+warning marks, and the remaining rendered ⎇/⏸/✓/✗ occurrences.
// Card d16a930c (2026-07-29) sorted the 27 entries left after b72b82f7 and
// closed the 5 that were genuinely RENDERED (ExplorerView's directory-toggle
// caret carried two code points on one line, so 6 entries drop for 5 fixes):
// ExplorerView's ▾/▸ and Sidebar/TileArea's static twins swap to
// GLYPH_ACTIONS.forward (CSS-rotated where the state must show, per the
// three-case ARIA tree below); RoadmapView's ✓ swaps to GLYPH_ACTIONS.check
// with the state moved onto the button (menuitemradio/aria-checked) instead
// of the glyph; GitView's ⎇ prefix moves out of the string field into a
// GLYPHS.git glyph rendered in the JSX span that already displays it.
//
// Every entry still below is EXEMPTED, not merely un-triaged -- named here so
// the next pass doesn't re-derive the same arbitration:
//   - 10 are main/preload PROCESS strings (journal lines, prompts, approval
//     banners): main/approval-service.ts, main/attention.ts,
//     main/companion-server.ts, main/context-wand.ts,
//     main/explorer-service.ts, main/index.ts (x2), main/ipc.ts,
//     main/startup-ack.ts, preload/browser-inspect.ts. DESIGN.md governs
//     rendered UI; a pictograph in a log/prompt line is not a control that
//     keeps its native look.
//   - 11 are COMMENT-ONLY mentions, verified as such (no JSX renders them):
//     App.tsx, BrowserView.tsx, ModelPicker.tsx ("★ pinned favorites"
//     banner), RoadmapView.tsx ("⏹ Stop button" note), SearchBar.tsx,
//     SnippetsDialog.tsx, TerminalTile.tsx, UsageLimitsModal.tsx,
//     store.ts, and shared/types.ts (both entries -- doc comments on
//     `lead` and `ExplorerRoot` describing UI drawn elsewhere).
// Like KNOWN_ORPHAN_KEYS and KNOWN_EMOJI_KEYS above, this baseline may only
// ever shrink from here, never grow.
const KNOWN_SOURCE_PICTOGRAPHS: string[] = [
  "main/approval-service.ts U+276F",
  "main/attention.ts U+276F",
  "main/companion-server.ts U+1F4F1",
  "main/context-wand.ts U+1FA84",
  "main/explorer-service.ts U+1F4C1",
  "main/index.ts U+1F4F1",
  "main/index.ts U+2387",
  "main/ipc.ts U+2387",
  "main/startup-ack.ts U+276F",
  "preload/browser-inspect.ts U+2316",
  "renderer/src/components/App.tsx U+2316",
  "renderer/src/components/BrowserView.tsx U+1F310",
  "renderer/src/components/ModelPicker.tsx U+2605",
  "renderer/src/components/RoadmapView.tsx U+23F9",
  "renderer/src/components/SearchBar.tsx U+1F50D",
  "renderer/src/components/SnippetsDialog.tsx U+26A1",
  "renderer/src/components/TerminalTile.tsx U+26A1",
  "renderer/src/components/UsageLimitsModal.tsx U+2715",
  "renderer/src/store.ts U+1F310",
  "shared/types.ts U+1F451",
  "shared/types.ts U+1F4C1",
];

test("no NEW pictograph code point anywhere in desktop/src beyond the known baseline", () => {
  const files = collectAllDesktopSrcFiles(DESKTOP_SRC);
  // Same sanity-floor rationale as the orphan-key check below: a broken scan
  // root collapses files towards 0, which would silently pass (an empty hit
  // list trivially satisfies toEqual against a shrinking baseline) instead
  // of failing loudly -- guard the file count directly.
  expect(files.length).toBeGreaterThan(100);
  const hits = findSourcePictographs(DESKTOP_SRC, files);
  expect(hits.sort()).toEqual([...KNOWN_SOURCE_PICTOGRAPHS].sort());
});

test("the source pictograph gate itself flags a NEW code point outside the baseline", () => {
  const root = freshDir();
  writeFileSync(join(root, "New.tsx"), "const x = '⏳ Queue'\n");
  const hits = findSourcePictographs(root, collectAllDesktopSrcFiles(root));
  expect(hits).toEqual(["New.tsx U+23F3"]);
});

// ----- orphan-key check: every EN_DEFAULTS key must have a producer -----
// A "producer" is either a literal 'key'/"key" occurrence found ANYWHERE in
// desktop/src (covers t('key') directly, a ternary of two literal keys, and
// indirection through a config object like `{ key: 'nav.home' }` consumed as
// t(v.key) -- the literal string still appears verbatim in the same file),
// or a dynamic key-template prefix discovered by scanning for
// `t(\`prefix.${...}\`)` call sites (e.g. roadmap.status.${s}). The
// whitelist of dynamic prefixes is derived from the source itself, not
// hand-maintained, so it self-updates as call sites are added or removed.

const DYNAMIC_PREFIX_RE = /\bt\(\s*`((?:[A-Za-z][A-Za-z0-9]*\.)+)\$\{/g;

function collectDesktopSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // main/i18n.ts and renderer/i18n.ts define/mirror the key set itself
    // (EN_DEFAULTS's own object keys) -- scanning them would make every key
    // trivially "produce itself", defeating the check.
    if (entry.name === "i18n.ts") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectDesktopSrcFiles(full));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function findOrphans(keys: string[], files: string[]): string[] {
  let src = "";
  for (const f of files) src += readFileSync(f, "utf-8") + "\n";
  const prefixes: string[] = [];
  for (const m of src.matchAll(DYNAMIC_PREFIX_RE)) prefixes.push(m[1]!);
  return keys.filter((key) => {
    if (src.includes(`'${key}'`) || src.includes(`"${key}"`)) return false;
    return !prefixes.some((p) => key.startsWith(p));
  });
}

// Pre-existing dead keys found by this check (card 69ca2661) were confirmed
// orphan by hand (grepped + read the would-be consumer, not just the regex)
// and removed from en.json/fr.json/i18n.ts (card 0b897710) once the sandbox
// i18n WIP that made these files contested had landed. This baseline stays
// empty going forward -- like KNOWN_MISSING_KEYS below, it may only ever
// shrink from here, never grow.
const KNOWN_ORPHAN_KEYS: string[] = [];

test("every EN_DEFAULTS key has a producer somewhere in desktop/src", () => {
  const files = collectDesktopSrcFiles(DESKTOP_SRC);
  // Sanity floor: if the scan root is ever wrong, files collapses towards 0,
  // findOrphans(EN_DEFAULTS keys, []) then reports EVERY key as orphan (no
  // source text to search), and this test fails LOUDLY against the (now
  // empty) KNOWN_ORPHAN_KEYS baseline -- this assertion turns that failure
  // into an obvious "scan root is broken" signal instead of a confusing wall
  // of spurious orphans to chase one by one.
  expect(files.length).toBeGreaterThan(100);
  const orphans = findOrphans(Object.keys(EN_DEFAULTS), files);
  // Any NEW orphan (beyond the known, tracked-for-cleanup baseline) fails
  // the test -- the baseline must only ever shrink, never grow.
  expect(orphans.sort()).toEqual([...KNOWN_ORPHAN_KEYS].sort());
});

test("the orphan check itself fails on a key with no producer -- proves it is load-bearing", () => {
  const files = collectDesktopSrcFiles(DESKTOP_SRC);
  const orphans = findOrphans(["definitely.not.a.real.key.anywhere"], files);
  expect(orphans).toEqual(["definitely.not.a.real.key.anywhere"]);
});

test("the orphan check covers a key only reachable through a discovered dynamic prefix", () => {
  const files = collectDesktopSrcFiles(DESKTOP_SRC);
  // roadmap.status.* is produced only via t(`roadmap.status.${s}`) in
  // RoadmapList/RoadmapView, never as a standalone literal -- if the prefix
  // scan ever breaks, this key would wrongly read as orphan even though
  // EN_DEFAULTS proves it is real.
  const dynamicKey = Object.keys(EN_DEFAULTS).find((k) => k.startsWith("roadmap.status."));
  expect(dynamicKey).toBeDefined();
  expect(findOrphans([dynamicKey!], files)).toEqual([]);
});

// ----- missing-key check: every literal t('...') call must resolve in EN_DEFAULTS -----
// The mirror image of the orphan check above (card 4600faed): a key that is
// CALLED but never DEFINED does not throw or warn -- t() falls back to
// returning the raw key string (see "t returns the raw key when the key is
// missing" above), so a typo or a renamed/removed EN_DEFAULTS entry surfaces
// only as a literal dotted string rendered verbatim in the UI, silently.
// Extraction reuses the same two ideas as the orphan check's dynamic-prefix
// scan: parse call sites structurally rather than by naive regex-only
// matching, and only claim a key is "used" when the call site's own text
// proves it -- no cross-file indirection tracing (a t(v.key) call with `key`
// defined elsewhere is out of scope here, same as the dynamic-prefix
// t(`prefix.${x}`) case, both left to the orphan check's coverage instead).
//
// Known tradeoff (reviewer, card 4600faed): the scan reads raw source text
// and does NOT strip comments or unrelated strings first. A literal like
// t('example.not.a.real.key') written inside a // comment, to illustrate
// something, is indistinguishable from a real call site and WILL fail this
// check for the whole team -- with a non-intuitive cause the day it happens.
// Deliberately not fixed here (stripping comments/strings correctly is its
// own can of worms); this sentence exists so the failure is looked up
// instead of debugged from scratch.
//
// The example literal above is safe here ONLY because this file lives in
// tests/, outside DESKTOP_SRC (desktop/src) -- the same line copied into a
// file under desktop/src would trip exactly the gate it describes.

// Matches the outer '(' of any standalone `t(` call (word-boundary before
// `t` excludes things like `format(`/`count(`, but still matches `.t(`
// member-call sites) -- NOT `useT(` (the hook, not the translator).
const T_CALL_RE = /\bt\(/g;
const KEY_SHAPE_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/;
const QUOTED_LITERAL_RE = /'([^'\\]*)'|"([^"\\]*)"/g;

// From `t(` 's own opening paren, walk the call quote-aware and depth-aware
// to isolate just the FIRST top-level argument (the key position) -- params
// like t('confirm.text', { detail: 'foo (bar)' }) must never leak literals
// from the second argument into the key set. Returns null on an unterminated
// (malformed) call, which the caller skips rather than mis-extracts.
function extractKeyArgText(src: string, openParenIdx: number): string | null {
  let depth = 0;
  let firstArgEnd = -1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inSingle) {
      if (c === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === "`" && prev !== "\\") inTemplate = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "`") {
      inTemplate = true;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) {
        const end = firstArgEnd === -1 ? i : firstArgEnd;
        return src.slice(openParenIdx + 1, end);
      }
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      continue;
    }
    if (c === "," && depth === 1 && firstArgEnd === -1) firstArgEnd = i;
  }
  return null; // unterminated call -- skip rather than guess
}

// Extracts every dotted-key-shaped quoted literal reachable from `t(`'s key
// position in one source string. A ternary key selector (t(cond ? 'a.b' :
// 'c.d')) yields both branches -- there is no single "the" key position to
// pick, so both count as used. A dynamic-prefix template (t(`prefix.${x}`))
// yields nothing (backticks never match QUOTED_LITERAL_RE), which is the
// intended out-of-scope behaviour, not a gap.
function collectUsedKeysFromSource(src: string): Set<string> {
  const used = new Set<string>();
  T_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = T_CALL_RE.exec(src))) {
    const openParenIdx = m.index + m[0].length - 1;
    const keyArgText = extractKeyArgText(src, openParenIdx);
    if (keyArgText === null) continue;
    QUOTED_LITERAL_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = QUOTED_LITERAL_RE.exec(keyArgText))) {
      const literal = lm[1] ?? lm[2] ?? "";
      if (KEY_SHAPE_RE.test(literal)) used.add(literal);
    }
  }
  return used;
}

function collectUsedKeys(files: string[]): Set<string> {
  const used = new Set<string>();
  for (const f of files) {
    for (const k of collectUsedKeysFromSource(readFileSync(f, "utf-8"))) used.add(k);
  }
  return used;
}

// No missing keys are known at the time this check was added -- unlike
// KNOWN_ORPHAN_KEYS above, this baseline starts empty. If it ever needs an
// entry, keep the same discipline: exact `toEqual`, never `arrayContaining`,
// so the list can only shrink and a fixed typo cannot silently regrow it.
const KNOWN_MISSING_KEYS: string[] = [];

test("every literal t('...') key used in desktop/src exists in EN_DEFAULTS", () => {
  const files = collectDesktopSrcFiles(DESKTOP_SRC);
  // Sanity floor, mirrored from the orphan check above but with the OPPOSITE
  // failure mode: if the scan root is ever wrong, files collapses towards 0,
  // collectUsedKeys([]) then yields an empty used set, so missing stays
  // empty too -- this test would SILENTLY PASS against the empty
  // KNOWN_MISSING_KEYS baseline despite having scanned nothing. This
  // assertion is what turns that silent pass into a loud, obvious failure.
  expect(files.length).toBeGreaterThan(100);
  const used = collectUsedKeys(files);
  const missing = [...used].filter((k) => !(k in EN_DEFAULTS));
  expect(missing.sort()).toEqual([...KNOWN_MISSING_KEYS].sort());
});

test("the missing-key check itself fails on a literal call to an undefined key -- proves it is load-bearing", () => {
  const used = collectUsedKeysFromSource("t('definitely.not.a.real.key.anywhere')");
  expect([...used]).toEqual(["definitely.not.a.real.key.anywhere"]);
});

test("the missing-key check extracts both branches of a ternary key selector", () => {
  const used = collectUsedKeysFromSource("t(cond ? 'a.b' : 'c.d')");
  expect([...used].sort()).toEqual(["a.b", "c.d"]);
});

test("the missing-key check does not flag a dynamic-prefix template call", () => {
  // Backtick templates never match QUOTED_LITERAL_RE -- this is the
  // documented out-of-scope carve-out, not a detection failure.
  const used = collectUsedKeysFromSource("t(`roadmap.status.${s}`)");
  expect([...used]).toEqual([]);
});

test("the missing-key check does not leak a literal from the params argument into the key set", () => {
  const used = collectUsedKeysFromSource("t('confirm.text', { detail: 'file.ext' })");
  expect([...used]).toEqual(["confirm.text"]);
});
