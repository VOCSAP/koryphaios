import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const DESKTOP_SRC = join(import.meta.dir, "..", "desktop", "src");

// Pre-existing dead keys found by this check (card 69ca2661), confirmed
// orphan by hand (grepped + read the would-be consumer, not just the regex):
//   - app.loading: the loading spinner (App.tsx) renders as a bare
//     aria-busy div, no text.
//   - workspaces.save / workspaces.saveAs: superseded by common.save /
//     saveas.title in SaveAsDialog.tsx; WorkspacesDialog.tsx uses a disjoint
//     set of workspaces.* keys for its restore/delete UI.
//   - sandbox.image: only a lexical collision with the unrelated
//     SandboxService.image() method call in ipc.ts.
//   - graph.modelDefault: no occurrence anywhere in GraphView.tsx or
//     elsewhere.
// Left in place rather than removed here: en.json/fr.json/i18n.ts currently
// carry large unrelated in-flight WIP from another session (a sandbox i18n
// feature), and locale files are a coordinate-first shared resource. This
// baseline keeps the check load-bearing against NEW orphans while the
// existing 5 are routed to their own cleanup card.
const KNOWN_ORPHAN_KEYS = [
  "app.loading",
  "workspaces.save",
  "workspaces.saveAs",
  "sandbox.image",
  "graph.modelDefault",
];

test("every EN_DEFAULTS key has a producer somewhere in desktop/src", () => {
  const files = collectDesktopSrcFiles(DESKTOP_SRC);
  // Sanity floor: if the scan root is ever wrong, files collapses towards 0
  // and every key would spuriously read as orphan -- or worse, this test
  // would silently pass on an empty producer set without this assertion.
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
